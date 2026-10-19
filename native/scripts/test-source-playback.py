#!/usr/bin/env python3
"""Execute source playback methods and reject late seek completions after pause."""
from pathlib import Path
import subprocess
import tempfile

root=Path(__file__).resolve().parents[2]
model=(root/'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
viewer=(root/'native/App/Shared/NativeEditor/NativeViewer.swift').read_text()
def declaration(marker):
    start=model.index(marker); begin=model.index('{',start); end=begin+1; depth=1
    while depth:
        depth+=(model[end]=='{')-(model[end]=='}'); end+=1
    return model[start:end]
source='''import Foundation
import CoreMedia
struct SourceAsset { var kind = "video" }
@MainActor final class Item { func cancelPendingSeeks() {} }
@MainActor final class Player {
    var currentItem: Item? = Item()
    var completion: ((Bool)->Void)?
    var playCount = 0
    var paused = true
    func seek(to:CMTime,toleranceBefore:CMTime,toleranceAfter:CMTime,completionHandler:((Bool)->Void)?=nil) { completion = completionHandler }
    func play() { paused = false; playCount += 1 }
    func pause() { paused = true }
}
'''+declaration('struct NativeSourceRange:')+'''
@MainActor final class Model {
    let sourcePlayer = Player()
    var sourceRange: NativeSourceRange? = NativeSourceRange(duration:10,fps:30)
    var sourceAsset: SourceAsset? = SourceAsset()
    var sourceGeneration = UUID(), sourcePlaybackGeneration = UUID()
    var sourcePlaying = false, sourceLoading = false, showingSource = true
    var sourceError: String?
'''+ '\n'.join(declaration(marker) for marker in ['    func seekSource(', '    func toggleSourcePlayback(', '    func pauseSource()'])+'''
}
@main struct Check {
    @MainActor static func main() async {
        let model = Model()
        model.sourceRange!.seek(10)
        model.toggleSourcePlayback()
        let late = model.sourcePlayer.completion!
        model.pauseSource()
        late(true)
        for _ in 0..<20 { await Task.yield() }
        precondition(!model.sourcePlaying && model.sourcePlayer.playCount == 0)
        precondition(model.sourceRange!.inPoint == 0 && model.sourceRange!.outPoint == 10)
        model.sourceRange!.seek(10)
        model.toggleSourcePlayback()
        model.sourcePlayer.completion!(true)
        for _ in 0..<20 { await Task.yield() }
        precondition(model.sourcePlaying && model.sourcePlayer.playCount == 1)
        model.pauseSource()
        precondition(!model.sourcePlaying && model.sourcePlayer.paused)
        print("Passed source pause, mark preservation and late seek-completion rejection.")
    }
}
'''
assert '.onDisappear { model.pauseSource() }' in viewer
with tempfile.TemporaryDirectory(prefix='reel-source-playback-') as temporary:
    folder=Path(temporary); swift=folder/'main.swift'; swift.write_text(source); binary=folder/'check'
    subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(folder/'cache'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
