#!/usr/bin/env python3
"""Run the candidate Photos controller and project-picker outcome policy, without a UI/backend."""
from pathlib import Path
import re
import subprocess
import tempfile

import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root',type=Path)
parser.add_argument('--contracts-only',action='store_true')
args=parser.parse_args()
repo=args.repo_root
candidate=args.source_root or repo
photos=(candidate/'native/App/Shared/NativeEditor/NativePhotosImport.swift').read_text()
picker=(candidate/'native/App/iOS/ReelIOSApp.swift').read_text()
request=photos.split('// BEGIN MEDIA IMPORT REQUEST\n',1)[1].split('// END MEDIA IMPORT REQUEST',1)[0]
controller=photos.split('// BEGIN PHOTOS IMPORT CONTROLLER\n',1)[1].split('// END PHOTOS IMPORT CONTROLLER',1)[0]
policy=picker.split('// BEGIN PROJECT PICKER OUTCOME\n',1)[1].split('// END PROJECT PICKER OUTCOME',1)[0]
assert 'return try NativePhotosImportBatch.confirmed(receipt)' in photos
assert 'model.status = outcome.summary' in photos
# Four admission sites: the Photos button and Import sheet `current` gates, plus
# NativeFilesImportCapture.init? and .matches (added with the Files import capture in fd4b5de).
assert photos.count('request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder)') == 4
assert photos.count('    private var current: Bool {\n        request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder)\n    }') == 2
assert photos.count('guard request.isCurrent(requestID: model.mediaImportRequest?.id, backend: session.backend, folder: session.folder),') == 2
# The Photos task body moved inside do { } in fd4b5de; the order is what matters, not the indent.
assert re.search(r'await model\.refresh\(\)\n[ ]+try Task\.checkCancellation\(\)\n[ ]+guard isCurrent\(\)', photos)
assert 'session.error = "Could not choose a project folder:' in picker
assert 'id == requestID && belongsToPresenter(panelID)' in request
if args.contracts_only:
 print('Native Photos/project-picker source contracts passed: 8', flush=True)
 raise SystemExit(0)
source='import Foundation\nfinal class ReelBackend {}\n'+request+controller+policy+r'''
@main struct Checks {
 @MainActor static func main() async throws {
  var count=0
  func check(_ ok:Bool,_ label:String){precondition(ok,label);count += 1}
  func file(_ item:Int)->URL{URL(fileURLWithPath:"/temp/item-\(item)/media.mov")}
  let backend=ReelBackend(), otherBackend=ReelBackend()
  let folder=URL(fileURLWithPath:"/disposable/Arya"), otherFolder=URL(fileURLWithPath:"/disposable/Other")
  let nestedRequest=NativeMediaImportRequest(backend:backend,folder:folder,panelID:"media")
  check(nestedRequest.matches(backend:backend,folder:folder),"Captured backend and folder match their original project")
  check(!nestedRequest.matches(backend:otherBackend,folder:folder) && !nestedRequest.matches(backend:backend,folder:otherFolder),"A same-folder reopened backend and another folder are stale")
  check(!nestedRequest.matches(backend:nil,folder:nil),"Closed project invalidates its captured picker")
  check(nestedRequest.isCurrent(requestID:nestedRequest.id,backend:backend,folder:folder),"Active picker is admitted only while its exact UUID and project remain current")
  check(!nestedRequest.isCurrent(requestID:nil,backend:backend,folder:folder),"Dismissed picker cannot admit a late provider selection in the same project")
  check(!nestedRequest.isCurrent(requestID:UUID(),backend:backend,folder:folder),"A replacement picker in the same project cannot admit the old selection")
  check(!nestedRequest.isCurrent(requestID:nestedRequest.id,backend:otherBackend,folder:folder),"UUID alone cannot admit a stale backend")
  check(nestedRequest.belongsToPresenter("media") && !nestedRequest.belongsToPresenter(nil) && !nestedRequest.belongsToPresenter("motion"),"Media owns its nested picker; it cannot also appear on editor or another panel")
  check(nestedRequest.canDismiss(fromRequestID:nestedRequest.id,panelID:"media"),"The actual presenting request can dismiss itself")
  check(!nestedRequest.canDismiss(fromRequestID:UUID(),panelID:"media") && !nestedRequest.canDismiss(fromRequestID:nestedRequest.id,panelID:nil),"An old dismissal or another presenter cannot clear a new request")
  let editorRequest=NativeMediaImportRequest(backend:backend,folder:folder,panelID:nil)
  check(editorRequest.belongsToPresenter(nil) && !editorRequest.belongsToPresenter("media"),"The editor owns a picker opened outside a panel")
  let populated=JSON(any:["assets":["media/a.mov":["duration":2]],"version":3])
  check(try NativePhotosImportBatch.confirmed(populated),"An import must be backed by probed assets")
  check(try !NativePhotosImportBatch.confirmed(JSON(any:["assets":[:],"version":4])),"Empty probe receipt must not count as an import")
  check(try !NativePhotosImportBatch.confirmed(JSON(any:["version":4])),"Absent assets must not count as an import")
  var copied:[Int]=[],cleaned:[Int]=[]
  let outcome=try await NativePhotosImportBatch.run(items:[1,2,3,4,5],isCurrent:{true},transfer:{ item in
   if item==2{return nil}
   if item==3{throw NSError(domain:"Photos",code:42,userInfo:[NSLocalizedDescriptionKey:"Download unavailable"])}
   return file(item)
  },copy:{url in
   let id=Int(url.deletingLastPathComponent().lastPathComponent.dropFirst(5))!
   copied.append(id)
   if id==5{throw NSError(domain:"Import",code:1,userInfo:[NSLocalizedDescriptionKey:"Commit outcome unknown"])}
   return id==1
  },cleanup:{url in cleaned.append(Int(url.deletingLastPathComponent().lastPathComponent.dropFirst(5))!)})
  check(outcome.confirmed==1 && outcome.unavailable==1 && outcome.unconfirmed==3,"Mixed batches must count confirmed/nil/transfer-error/probe-error/uncertain-copy outcomes")
  check(copied==[1,4,5],"Nil transfers and failed downloads must not copy; recoverable errors must allow later items")
  check(cleaned==[1,4,5],"Every transferred temp directory must be cleaned on success, empty probe, and copy error")
  check(outcome.summary.contains("Imported 1 item from Photos") && outcome.summary.contains("1 unavailable") && outcome.summary.contains("3 not confirmed"),"Success text must reflect actual receipts, not selection count")
  check(outcome.summary.contains("Download unavailable") && outcome.summary.contains("Check Media"),"Partial outcomes need a concrete issue and explicit retry guidance")

  var current=true
  var waiting:CheckedContinuation<URL?,Error>?
  var staleCopies=0,staleCleanup=0
  let stale=Task { @MainActor in
   try await NativePhotosImportBatch.run(items:[1,2],isCurrent:{current},transfer:{_ in
    try await withCheckedThrowingContinuation {waiting=$0}
   },copy:{_ in staleCopies += 1;return true},cleanup:{_ in staleCleanup += 1})
  }
  while waiting==nil{await Task.yield()}
  current=false
  waiting!.resume(returning:file(1))
  do{_ = try await stale.value;preconditionFailure("Stale project import allowed")}catch is CancellationError{}
  check(staleCopies==0 && staleCleanup==1,"A late transfer after project/backend switch must clean its temp file and never write")

  current=true;waiting=nil
  let cancelled=Task { @MainActor in
   try await NativePhotosImportBatch.run(items:[1],isCurrent:{current},transfer:{_ in
    try await withCheckedThrowingContinuation {waiting=$0}
   },copy:{_ in staleCopies += 1;return true},cleanup:{_ in staleCleanup += 1})
  }
  while waiting==nil{await Task.yield()}
  cancelled.cancel();waiting!.resume(returning:file(1))
  do{_ = try await cancelled.value;preconditionFailure("Cancelled transfer copied")}catch is CancellationError{}
  check(staleCopies==0 && staleCleanup==2,"A cancelled late transfer must clean its temp file without a misleading completion")

  current=true
  var laterTransfers=0
  do{
   _ = try await NativePhotosImportBatch.run(items:[1,2],isCurrent:{current},transfer:{item in laterTransfers += 1;return file(item)},copy:{_ in current=false;return true},cleanup:{_ in staleCleanup += 1})
   preconditionFailure("Late receipt from another project allowed")
  }catch is CancellationError{}
  check(laterTransfers==1,"A project switch during copy must block the next transfer and aggregate success status")

  current=true
  do{
   _ = try await NativePhotosImportBatch.run(items:[1,2],isCurrent:{current},transfer:{_ in current=false;throw NSError(domain:"Photos",code:9)},copy:{_ in preconditionFailure("Stale error copied")},cleanup:{_ in})
   preconditionFailure("Stale transfer error reported as current result")
  }catch is CancellationError{}
  count += 1
  let allNil=try await NativePhotosImportBatch.run(items:[1,2],isCurrent:{true},transfer:{_ in nil},copy:{_ in preconditionFailure("Nil copied")},cleanup:{_ in preconditionFailure("No temp to clean")})
  check(allNil.confirmed==0 && allNil.unavailable==2,"An all-unavailable Photos selection must never claim imports")
  let chosen=URL(fileURLWithPath:"/project")
  check(try NativeProjectPickerOutcome.folder(.success(chosen))==chosen,"Successful folder selection must retain existing open/create route")
  check(try NativeProjectPickerOutcome.folder(.failure(CancellationError()))==nil,"Task cancellation is a quiet picker outcome")
  check(try NativeProjectPickerOutcome.folder(.failure(NSError(domain:NSCocoaErrorDomain,code:NSUserCancelledError)))==nil,"User cancelling Files must stay quiet")
  let provider=NSError(domain:NSCocoaErrorDomain,code:NSFileReadNoPermissionError,userInfo:[NSLocalizedDescriptionKey:"Folder access denied"])
  do{_ = try NativeProjectPickerOutcome.folder(.failure(provider));preconditionFailure("Provider failure ignored")}catch{check(error.localizedDescription=="Folder access denied","Files provider errors must reach the visible failure route")}
  print("PASS: \(count) candidate import/picker controller assertions")
 }
}
'''
with tempfile.TemporaryDirectory(prefix='arya-import-outcomes-') as temp:
 d=Path(temp);swift=d/'Checks.swift';binary=d/'checks';swift.write_text(source)
 subprocess.run(['swiftc','-j1','-parse-as-library','-module-cache-path',str(d/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(swift),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
