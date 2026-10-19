import CoreVideo
import Foundation
import Metal

extension ReelMetalRenderer {
    func videoTexture(_ buffer: CVPixelBuffer, command: MTLCommandBuffer) throws -> MTLTexture {
        guard CVPixelBufferGetPlaneCount(buffer) == 2 else { throw ReelRenderingError("native video requires a two-plane pixel buffer") }
        let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer)
        var shared:[CVMetalTexture]=[]
        func plane(_ index:Int,_ format:MTLPixelFormat) throws -> MTLTexture {
            let width=CVPixelBufferGetWidthOfPlane(buffer,index),height=CVPixelBufferGetHeightOfPlane(buffer,index)
            var reference:CVMetalTexture?
            if CVMetalTextureCacheCreateTextureFromImage(nil,textureCache,buffer,nil,format,width,height,index,&reference) == kCVReturnSuccess,let reference,let texture=CVMetalTextureGetTexture(reference) {shared.append(reference);return texture}
            // Software decoders may return planes without an IOSurface, including Simulator.
            CVPixelBufferLockBaseAddress(buffer,.readOnly);defer {CVPixelBufferUnlockBaseAddress(buffer,.readOnly)}
            guard let bytes=CVPixelBufferGetBaseAddressOfPlane(buffer,index) else {throw ReelRenderingError("decoded video plane has no readable data")}
            let texture=try texture(width,height,format:format)
            texture.replace(region:MTLRegionMake2D(0,0,width,height),mipmapLevel:0,withBytes:bytes,bytesPerRow:CVPixelBufferGetBytesPerRowOfPlane(buffer,index))
            return texture
        }
        let y=try plane(0,.r8Unorm),uv=try plane(1,.rg8Unorm)
        let matrix = CVBufferCopyAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil) as? String
        let coefficients: [Float] = matrix == kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String ? [1.792741,-0.213249,-0.532909,2.112402] : matrix == kCVImageBufferYCbCrMatrix_ITU_R_2020 as String ? [1.678674,-0.187326,-0.650424,2.141772] : [1.596027,-0.391762,-0.812968,2.017232]
        let full = CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        let result = try texture(w,h)
        let fullChromaScale: Float = Float(224) / Float(255)
        let videoOffset: Float = Float(16) / Float(255)
        let videoScale: Float = Float(255) / Float(219)
        let chromaScale: Float = full ? fullChromaScale : 1
        let range: [Float] = full ? [0,1] : [videoOffset,videoScale]
        let uniforms: [String: [Float]] = ["uCoefficients": coefficients.map { $0 * chromaScale }, "uRange": range, "uChromaNearest": [0]]
        try pass("yuv",textures:[y,uv],target:result,uniforms:uniforms,command:command)
        let retained = NativeVideoPlanes(buffer: buffer, shared:shared)
        command.addCompletedHandler { _ in _ = retained }
        return result
    }
}

private final class NativeVideoPlanes: @unchecked Sendable {
    let buffer:CVPixelBuffer,shared:[CVMetalTexture]
    init(buffer:CVPixelBuffer,shared:[CVMetalTexture]) {self.buffer=buffer;self.shared=shared}
}
