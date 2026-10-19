import CoreImage
import Foundation
import Metal
import Vision

/// Motion-aware temporal and bilateral spatial reduction on the Metal device.
public final class NativeVideoDenoiser {
    public struct Options: Sendable {
        public var quality: String, strength: Double, spatial: Double, temporal: Double, detail: Double, sigma: Double
        public init(quality: String = "balanced", strength: Double = 0.65, spatial: Double = 0.5, temporal: Double = 0.8, detail: Double = 0.7, sigma: Double = 0.06) {
            self.quality=quality; self.strength=strength; self.spatial=spatial; self.temporal=temporal; self.detail=detail; self.sigma=sigma
        }
        public var radius: Int { strength == 0 || temporal == 0 || quality == "fast" ? 0 : quality == "high" ? 2 : 1 }
        public func validate() throws {
            guard ["fast","balanced","high"].contains(quality), [strength,spatial,temporal,detail].allSatisfy({ $0.isFinite && (0...1).contains($0) }), sigma.isFinite, (0.002...0.25).contains(sigma) else { throw ReelBackend.APIError("Denoise needs fast, balanced or high quality, controls from 0 to 1, and noise sigma from 0.002 to 0.25.") }
        }
    }

    let device: MTLDevice, queue: MTLCommandQueue, pipeline: MTLComputePipelineState
    let context: CIContext, space: CGColorSpace
    public init(colorSpace:CGColorSpace = CGColorSpace(name:CGColorSpace.extendedLinearSRGB)!) throws {
        guard let device=MTLCreateSystemDefaultDevice(),let queue=device.makeCommandQueue() else { throw ReelBackend.APIError("GPU video denoise needs a Metal device.") }
        self.device=device; self.queue=queue; self.space=colorSpace
        context=CIContext(mtlDevice:device,options:[.cacheIntermediates:false])
        let library=try device.makeLibrary(source:Self.shader,options:nil)
        pipeline=try device.makeComputePipelineState(function:library.makeFunction(name:"denoise")!)
    }

    public func filter(_ center: CGImage, neighbors: [CGImage], options: Options) throws -> CIImage {
        try filter(CIImage(cgImage:center),neighbors:neighbors.map { CIImage(cgImage:$0) },options:options)
    }

    public func filter(_ center:CIImage,neighbors:[CIImage],options:Options) throws -> CIImage {
        try options.validate(); try Task.checkCancellation()
        if options.strength == 0 || options.spatial == 0 && options.radius == 0 { return center }
        let adjacent = Array(neighbors.prefix(options.radius * 2))
        guard adjacent.allSatisfy({ $0.extent == center.extent }) else { throw ReelBackend.APIError("Temporal denoise needs frames with matching dimensions and origins.") }
        let scale=min(1,512/max(center.extent.width,center.extent.height))
        func preview(_ image:CIImage) throws -> CGImage { let small=image.transformed(by:CGAffineTransform(scaleX:scale,y:scale));guard let result=context.createCGImage(small,from:small.extent,format:.RGBA8,colorSpace:CGColorSpace(name:CGColorSpace.sRGB)!) else { throw ReelBackend.APIError("Cannot create a bounded motion preview.") };return result }
        return try filter(center,neighbors:adjacent,reference:preview(center),neighborReferences:adjacent.map(preview),options:options)
    }

    public static func validateMemory(width:Int,height:Int,neighbors:Int,wide:Bool=false,limit:UInt64=NativeAudioMixer.memoryLimitBytes) throws {
        let tileSize=512,padding=3,count=max(0,min(4,neighbors)),sourceBytes=wide ? 8:4
        let estimated=(Double(width)*Double(height)*Double(8+(count+2)*sourceBytes)+Double(6*(tileSize+padding*2)*(tileSize+padding*2)*8))*1.25
        guard width>0,height>0,width<=16384,height<=16384,estimated<=Double(limit) else { throw ReelBackend.APIError("This video frame exceeds the device's processing memory budget. Use a smaller source or fewer temporal neighbors.") }
    }

    private func filter(_ base:CIImage,neighbors:[CIImage],reference:CGImage,neighborReferences:[CGImage],options:Options) throws -> CIImage {
        try options.validate(); try Task.checkCancellation()
        let rect=base.extent,width=Int(rect.width),height=Int(rect.height)
        let count=min(4,neighbors.count), tileSize=512, padding=3
        try Self.validateMemory(width:width,height:height,neighbors:count,wide:space.name==NativeHDR.workingSpace.name)
        var images=[base]
        for (i,neighbor) in neighbors.prefix(4).enumerated() {
            try Task.checkCancellation()
            var alignment=try Self.translation(reference:reference,floating:neighborReferences[i])
            alignment.tx*=rect.width/Double(reference.width);alignment.ty*=rect.height/Double(reference.height)
            let moved=neighbor.transformed(by:alignment).clampedToExtent().cropped(to:rect)
            images.append(moved)
        }
        let output=try texture(width,height)
        for y in stride(from:0,to:height,by:tileSize) { for x in stride(from:0,to:width,by:tileSize) { try autoreleasepool {
            try Task.checkCancellation()
            let tile=CGRect(x:x,y:y,width:min(tileSize,width-x),height:min(tileSize,height-y)),roi=tile.insetBy(dx:-CGFloat(padding),dy:-CGFloat(padding)).intersection(rect)
            var textures=try images.map { try upload($0.cropped(to:roi)) }
            while textures.count<5 { textures.append(textures[0]) }
            guard let command=queue.makeCommandBuffer(),let encoder=command.makeComputeCommandEncoder() else { throw ReelBackend.APIError("Cannot start GPU video denoise.") }
            let params=[Float(options.strength),Float(options.spatial),Float(options.temporal),Float(options.detail),Float(options.sigma),Float(count),Float(options.quality == "high" ? 3 : options.quality == "fast" ? 1 : 2),0,Float(tile.minX-roi.minX),Float(tile.minY-roi.minY),Float(tile.width),Float(tile.height),Float(x),Float(y),space.name==CGColorSpace.extendedLinearSRGB ? 1:0]
            encoder.setComputePipelineState(pipeline)
            for (i,texture) in textures.enumerated() { encoder.setTexture(texture,index:i) }
            encoder.setTexture(output,index:5); params.withUnsafeBytes { encoder.setBytes($0.baseAddress!,length:$0.count,index:0) }
            let width=pipeline.threadExecutionWidth
            encoder.dispatchThreads(MTLSize(width:Int(tile.width),height:Int(tile.height),depth:1),threadsPerThreadgroup:MTLSize(width:width,height:max(1,pipeline.maxTotalThreadsPerThreadgroup/width),depth:1))
            encoder.endEncoding(); command.commit(); command.waitUntilCompleted()
            if let error=command.error { throw error }
        } } }
        try Task.checkCancellation()
        guard let image=CIImage(mtlTexture:output,options:[.colorSpace:space]) else { throw ReelBackend.APIError("Cannot read the denoised GPU frame.") }
        return image
    }

    public static func translation(reference: CGImage, floating: CGImage) throws -> CGAffineTransform {
        let request=VNTranslationalImageRegistrationRequest(targetedCGImage:floating,options:[:])
        try VNImageRequestHandler(cgImage:reference,options:[:]).perform([request])
        let transform=request.results?.first?.alignmentTransform ?? .identity
        guard transform.tx.isFinite,transform.ty.isFinite,abs(transform.tx)<Double(reference.width)*0.3,abs(transform.ty)<Double(reference.height)*0.3 else { return .identity }
        return transform
    }

    public static func noise(_ image: CGImage) throws -> Double {
        let data=try NativeVideoProcessing.rgba(image), width=image.width,height=image.height
        var estimates:[Double]=[]
        for y in stride(from:1,to:height-1,by:2) { for x in stride(from:1,to:width-1,by:2) {
            let i=(y*width+x)*4
            let horizontal=abs(Int(data[i-4])-Int(data[i+4])),vertical=abs(Int(data[i-width*4])-Int(data[i+width*4]))
            if horizontal+vertical<30 { let lap=Double(data[i])*4-Double(data[i-4])-Double(data[i+4])-Double(data[i-width*4])-Double(data[i+width*4]); estimates.append(abs(lap)/sqrt(20)/255) }
        } }
        estimates.sort()
        return estimates.isEmpty ? 0 : estimates[estimates.count/2]/0.67449
    }

    func texture(_ width:Int,_ height:Int) throws -> MTLTexture {
        let descriptor=MTLTextureDescriptor.texture2DDescriptor(pixelFormat:.rgba16Float,width:width,height:height,mipmapped:false)
        descriptor.usage=[.shaderRead,.shaderWrite];descriptor.storageMode = .shared
        guard let result=device.makeTexture(descriptor:descriptor) else { throw ReelBackend.APIError("Cannot allocate GPU denoise textures.") };return result
    }
    func upload(_ image:CIImage) throws -> MTLTexture {
        let result=try texture(Int(image.extent.width),Int(image.extent.height)), destination=CIRenderDestination(mtlTexture:result,commandBuffer:nil)
        destination.colorSpace=space
        let task=try context.startTask(toRender:image,from:image.extent,to:destination,at:.zero);_=try task.waitUntilCompleted()
        return result
    }

    static let shader = """
    #include <metal_stdlib>
    using namespace metal;
    constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);
    float3 read(texture2d<float> t,float2 uv){return t.sample(s,uv).rgb;}
    kernel void denoise(texture2d<float> c [[texture(0)]],texture2d<float> n0 [[texture(1)]],texture2d<float> n1 [[texture(2)]],texture2d<float> n2 [[texture(3)]],texture2d<float> n3 [[texture(4)]],texture2d<float,access::write> out [[texture(5)]],constant float *p [[buffer(0)]],uint2 gid [[thread_position_in_grid]]) {
      if(gid.x>=uint(p[10])||gid.y>=uint(p[11]))return;
      float2 size=float2(c.get_width(),c.get_height()),uv=(float2(gid)+0.5+float2(p[8],p[9]))/size;
      float4 center=c.sample(s,uv);float3 sum=center.rgb;float weight=1.0;
      float sigma=max(0.002,p[4]);if(p[14]>0.5){float l=max(0.0001,dot(center.rgb,float3(0.2126,0.7152,0.0722)));sigma*=max(1.0/12.92,2.4/1.055*pow(l,1.4/2.4));}float variance=sigma*sigma,detail=p[3];int radius=int(p[6]);
      for(int y=-radius;y<=radius;y++)for(int x=-radius;x<=radius;x++){
        if(x==0&&y==0)continue;
        float4 adjacent=c.sample(s,uv+float2(x,y)/size);float3 v=adjacent.rgb,d=v-center.rgb;
        float w=exp(-float(x*x+y*y)/(float(radius*radius)+0.001))*exp(-dot(d,d)/(variance*(3.0-1.5*detail)))*exp(-abs(adjacent.a-center.a)*20.0)*p[1]*p[0];sum+=v*w;weight+=w;
      }
      for(int i=0;i<int(p[5]);i++){
        float4 adjacent=i==0?n0.sample(s,uv):i==1?n1.sample(s,uv):i==2?n2.sample(s,uv):n3.sample(s,uv);float3 v=adjacent.rgb;
        float error=0.0;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          float2 q=uv+float2(x,y)/size;float3 r=i==0?read(n0,q):i==1?read(n1,q):i==2?read(n2,q):read(n3,q);float3 d=read(c,q)-r;error+=dot(d,d)/27.0;
        }
        float3 difference=v-center.rgb;
        float w=exp(-max(0.0,error-variance*1.5)/(variance*(1.5-detail)))*exp(-dot(difference,difference)/(variance*12.0))*exp(-abs(adjacent.a-center.a)*20.0)*p[2]*p[0];sum+=v*w;weight+=w;
      }
      out.write(float4(sum/weight,center.a),gid+uint2(p[12],p[13]));
    }
    """
}
