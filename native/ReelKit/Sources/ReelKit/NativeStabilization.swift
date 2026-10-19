import CoreImage
import Foundation
import simd
import Vision

public enum NativeStabilization {
    public struct Options: Sendable {
        public var smoothing: Double, strength: Double, crop: String, maxCrop: Double, model: String
        public init(smoothing:Double=0.4,strength:Double=1,crop:String="auto",maxCrop:Double=0.2,model:String="translation") { self.smoothing=smoothing;self.strength=strength;self.crop=crop;self.maxCrop=maxCrop;self.model=model }
        public func validate() throws {
            guard smoothing.isFinite,(0.1...3).contains(smoothing),strength.isFinite,(0...1).contains(strength),maxCrop.isFinite,(0...0.3).contains(maxCrop),["auto","fixed","none"].contains(crop),["translation","homography"].contains(model) else { throw ReelBackend.APIError("Stabilization needs smoothing from 0.1 to 3 seconds, strength from 0 to 1, crop from 0 to 0.3, and a translation or homography model.") }
        }
    }

    public struct Path: Sendable {
        let corrections:[simd_double3x3]
        public let zoom:Double, requiredZoom:Double, sourceRMS:Double, outputRMS:Double
        public var json:JSON { .object([("sourceMotionRMS",.number(sourceRMS)),("outputMotionRMS",.number(outputRMS)),("zoom",.number(zoom)),("requiredZoom",.number(requiredZoom)),("cropLimited",.bool(requiredZoom>zoom+0.0001))]) }
        public func image(_ source:CGImage,frame:Int) -> CIImage {
            image(CIImage(cgImage:source),frame:frame)
        }
        public func image(_ base:CIImage,frame:Int) -> CIImage {
            let rect=base.extent,m=corrections[frame]
            let warped:CIImage
            if abs(m.columns.0.z)+abs(m.columns.1.z)<1e-9 {
                let transform=CGAffineTransform(a:m.columns.0.x/m.columns.2.z,b:m.columns.0.y/m.columns.2.z,c:m.columns.1.x/m.columns.2.z,d:m.columns.1.y/m.columns.2.z,tx:m.columns.2.x/m.columns.2.z,ty:m.columns.2.y/m.columns.2.z)
                warped=base.clampedToExtent().transformed(by:transform)
            } else {
                let tl=point(m,0,rect.height),tr=point(m,rect.width,rect.height),br=point(m,rect.width,0),bl=point(m,0,0)
                warped=base.applyingFilter("CIPerspectiveTransform",parameters:["inputTopLeft":CIVector(cgPoint:tl),"inputTopRight":CIVector(cgPoint:tr),"inputBottomRight":CIVector(cgPoint:br),"inputBottomLeft":CIVector(cgPoint:bl)]).clampedToExtent()
            }
            let z=CGAffineTransform(translationX:rect.midX,y:rect.midY).scaledBy(x:zoom,y:zoom).translatedBy(x:-rect.midX,y:-rect.midY)
            return warped.transformed(by:z).cropped(to:rect)
        }
    }

    public static func alignment(reference:CGImage,floating:CGImage,model:String) throws -> simd_double3x3 {
        if model=="homography" {
            let request=VNHomographicImageRegistrationRequest(targetedCGImage:floating,options:[:])
            try VNImageRequestHandler(cgImage:reference,options:[:]).perform([request])
            if let result=request.results?.first {
                let f=result.warpTransform
                let m=simd_double3x3(SIMD3<Double>(f.columns.0),SIMD3<Double>(f.columns.1),SIMD3<Double>(f.columns.2))
                let determinant=simd_determinant(m)
                if determinant.isFinite,abs(determinant)>0.01 {
                    let moved=point(m,Double(reference.width)/2,Double(reference.height)/2)
                    if moved.x.isFinite,moved.y.isFinite,abs(moved.x-Double(reference.width)/2)<Double(reference.width)*0.3,abs(moved.y-Double(reference.height)/2)<Double(reference.height)*0.3,let normalized=try? validated(m,width:reference.width,height:reference.height) { return normalized }
                }
            }
        }
        let t=try NativeVideoDenoiser.translation(reference:reference,floating:floating)
        return simd_double3x3(SIMD3(t.a,t.b,0),SIMD3(t.c,t.d,0),SIMD3(t.tx,t.ty,1))
    }

    public static func path(_ camera:[simd_double3x3],width:Int,height:Int,fps:Double,options:Options,zoom:Double) throws -> Path {
        try options.validate();guard !camera.isEmpty else { throw ReelBackend.APIError("Stabilization found no frames.") }
        guard width>0,height>0,width<=16384,height<=16384,fps.isFinite,fps>0,fps<=240,zoom.isFinite,(1...1.5).contains(zoom) else { throw ReelBackend.APIError("The stabilization dimensions, frame rate or zoom are invalid.") }
        let camera=try camera.map {try Task.checkCancellation();return try validated($0,width:width,height:height)}
        let radius=max(1,Int(ceil(options.smoothing*fps))),sigma=max(1,Double(radius)/2)
        var corrections:[simd_double3x3]=[]
        for i in camera.indices {
            try Task.checkCancellation()
            var average=simd_double3x3(0),total=0.0
            for j in max(0,i-radius)...min(camera.count-1,i+radius) { if j % 128 == 0 { try Task.checkCancellation() }; let weight=exp(-Double((j-i)*(j-i))/(2*sigma*sigma));average+=camera[j]*weight;total+=weight }
            average*=1/total
            average=try validated(average,width:width,height:height)
            let correction=average*simd_inverse(camera[i]),identity=matrix_identity_double3x3
            corrections.append(try validated(identity+(correction-identity)*options.strength,width:width,height:height))
        }
        func covers(_ m:simd_double3x3,_ zoom:Double)->Bool {
            let inv=simd_inverse(m),cx=Double(width)/2,cy=Double(height)/2
            for x in [0.0,Double(width)] {for y in [0.0,Double(height)] {let p=point(inv,cx+(x-cx)/zoom,cy+(y-cy)/zoom);if !p.x.isFinite || !p.y.isFinite || p.x < -0.001 || p.y < -0.001 || p.x>Double(width)+0.001 || p.y>Double(height)+0.001{return false}}}
            return true
        }
        var required=1.0
        for m in corrections {try Task.checkCancellation();var low=1.0,high=2.0;for _ in 0..<24 {let mid=(low+high)/2;if covers(m,mid){high=mid}else{low=mid}};required=max(required,high)}
        let applied=options.crop=="none" ? 1 : options.crop=="fixed" ? zoom : min(required,1/(1-options.maxCrop))
        func rms(_ list:[simd_double3x3])->Double {var energy=0.0;for i in 1..<list.count {let a=point(list[i-1],Double(width)/2,Double(height)/2),b=point(list[i],Double(width)/2,Double(height)/2);energy+=pow(b.x-a.x,2)+pow(b.y-a.y,2)};return sqrt(energy/Double(max(1,list.count-1)))}
        return Path(corrections:corrections,zoom:applied,requiredZoom:required,sourceRMS:rms(camera),outputRMS:rms(zip(corrections,camera).map { $0.0*$0.1 }))
    }

    static func validated(_ matrix:simd_double3x3,width:Int,height:Int) throws -> simd_double3x3 {
        func finite(_ m:simd_double3x3)->Bool { [m.columns.0,m.columns.1,m.columns.2].allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite } }
        guard finite(matrix),abs(matrix.columns.2.z)>1e-8 else { throw invalidPath }
        let normalized=matrix*(1/matrix.columns.2.z),determinant=simd_determinant(normalized)
        guard determinant.isFinite,abs(determinant)>1e-8 else { throw invalidPath }
        let inverse=simd_inverse(normalized)
        guard finite(inverse) else { throw invalidPath }
        for m in [normalized,inverse] {for x in [0.0,Double(width)] {for y in [0.0,Double(height)] {let p=m*SIMD3(x,y,1);guard p.z.isFinite,p.z>1e-8,p.x.isFinite,p.y.isFinite else {throw invalidPath};let mapped=point(m,x,y);guard mapped.x.isFinite,mapped.y.isFinite,abs(mapped.x)<Double(width)*100,abs(mapped.y)<Double(height)*100 else {throw invalidPath}}}}
        return normalized
    }
    private static var invalidPath:ReelBackend.APIError { .init("The motion path became singular or crossed its image plane. Use translation registration or a shorter range.") }
}

private func point(_ matrix:simd_double3x3,_ x:Double,_ y:Double)->CGPoint {
    let result=matrix*SIMD3(x,y,1)
    guard result.z.isFinite,abs(result.z)>1e-8 else { return CGPoint(x:Double.nan,y:Double.nan) }
    return CGPoint(x:result.x/result.z,y:result.y/result.z)
}
