import MetalKit
import SwiftUI
#if os(iOS)
import UIKit
#endif

#if DEBUG
enum NativePresentationDiagnostics {
    static var draws = 0
    static var inactiveDraws = 0
    static var unavailableDrawables = 0
    static var error: String?
}
#endif

/// Presents the rendered texture directly. Scopes request a separate pixel readback.
struct NativeMetalViewer: View {
    let texture: MTLTexture
    var body: some View { MetalSurface(texture: texture) }
}

private struct MetalSurface {
    let texture: MTLTexture
    func makeCoordinator() -> MetalPresenter { MetalPresenter(device: texture.device) }
    func makeView(_ coordinator: MetalPresenter) -> MTKView {
        let view = MTKView(frame: .zero, device: texture.device)
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColorMake(0, 0, 0, 1)
        view.isPaused = true; view.enableSetNeedsDisplay = true
        view.framebufferOnly = true; view.delegate = coordinator
        coordinator.texture = texture
        return view
    }
    func update(_ view: MTKView, coordinator: MetalPresenter) {
        coordinator.texture = texture
        #if os(iOS)
        view.setNeedsDisplay()
        #else
        view.needsDisplay = true
        #endif
    }
}

#if os(iOS)
extension MetalSurface: UIViewRepresentable {
    func makeUIView(context: Context) -> MTKView { makeView(context.coordinator) }
    func updateUIView(_ uiView: MTKView, context: Context) { update(uiView, coordinator: context.coordinator) }
}
#else
extension MetalSurface: NSViewRepresentable {
    func makeNSView(context: Context) -> MTKView { makeView(context.coordinator) }
    func updateNSView(_ nsView: MTKView, context: Context) { update(nsView, coordinator: context.coordinator) }
}
#endif

private final class MetalPresenter: NSObject, MTKViewDelegate {
    var texture: MTLTexture?
    private let queue: MTLCommandQueue?
    private let pipeline: MTLRenderPipelineState?
    init(device: MTLDevice) {
        queue = device.makeCommandQueue()
        let source = """
        #include <metal_stdlib>
        using namespace metal;
        struct Vertex { float4 position [[position]]; float2 uv; };
        vertex Vertex reelPresentVertex(uint id [[vertex_id]], constant float2 &scale [[buffer(0)]]) {
            const float2 positions[] = {float2(-1,1),float2(-1,-1),float2(1,1),float2(1,-1)};
            const float2 coords[] = {float2(0,0),float2(0,1),float2(1,0),float2(1,1)};
            return {float4(positions[id]*scale,0,1),coords[id]};
        }
        fragment float4 reelPresentFragment(Vertex input [[stage_in]], texture2d<float> image [[texture(0)]]) {
            constexpr sampler linear(filter::linear,address::clamp_to_edge);
            return image.sample(linear,input.uv);
        }
        """
        do {
            let library = try device.makeLibrary(source: source, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "reelPresentVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "reelPresentFragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            pipeline = nil
            #if DEBUG
            NativePresentationDiagnostics.error = error.localizedDescription
            #endif
        }
        super.init()
    }
    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { view.draw() }
    func draw(in view: MTKView) {
        #if os(iOS)
        guard UIApplication.shared.applicationState == .active else {
            #if DEBUG
            NativePresentationDiagnostics.inactiveDraws += 1
            #endif
            return
        }
        #endif
        guard view.drawableSize.width > 0, view.drawableSize.height > 0, let texture, let pipeline,
              let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
              let command = queue?.makeCommandBuffer(), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else {
            #if DEBUG
            NativePresentationDiagnostics.unavailableDrawables += 1
            #endif
            return
        }
        let sourceAspect = Float(texture.width) / Float(texture.height), targetAspect = Float(view.drawableSize.width / view.drawableSize.height)
        var scale = SIMD2<Float>(min(1, sourceAspect / targetAspect), min(1, targetAspect / sourceAspect))
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBytes(&scale, length: MemoryLayout<SIMD2<Float>>.stride, index: 0)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding(); command.present(drawable)
        #if DEBUG
        command.addCompletedHandler { buffer in
            DispatchQueue.main.async {
                if buffer.status == .completed { NativePresentationDiagnostics.draws += 1 }
                else { NativePresentationDiagnostics.error = buffer.error?.localizedDescription ?? "Metal presentation did not complete." }
            }
        }
        #endif
        command.commit()
    }
}
