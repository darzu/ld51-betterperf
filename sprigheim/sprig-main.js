import { getPositionFromTransform, moveX, moveY, moveZ, pitch, yaw } from '../3d-util.js';
import { mat4, vec3 } from '../ext/gl-matrix.js';
import { align } from '../math.js';
import { initGrassSystem } from './grass.js';
import { createMeshPoolBuilder_WebGPU, Vertex, MeshUniform, SceneUniform, unshareProvokingVertices } from './mesh-pool.js';
import { createWaterSystem } from './water.js';
// Defines shaders in WGSL for the shadow and regular rendering pipelines. Likely you'll want
// these in external files but they've been inlined for redistribution convenience.
// shader common structs
const shaderSceneStruct = `
    [[block]] struct Scene {
        cameraViewProjMatrix : mat4x4<f32>;
        lightViewProjMatrix : mat4x4<f32>;
        lightDir : vec3<f32>;
        time : f32;
        targetSize: vec2<f32>;
        cameraPos : vec3<f32>;
    };
`;
const vertexShaderOutput = `
    [[location(0)]] shadowPos : vec3<f32>;
    [[location(1)]] [[interpolate(flat)]] normal : vec3<f32>;
    [[location(2)]] [[interpolate(flat)]] color : vec3<f32>;
    [[location(3)]] worldPos : vec3<f32>;
    [[builtin(position)]] position : vec4<f32>;
`;
// shader code
const vertexShaderForShadows = `
    ${shaderSceneStruct}


    [[block]] struct Model {
    ${MeshUniform.GenerateWGSLUniformStruct()}
    };

    [[group(0), binding(0)]] var<uniform> scene : Scene;
    [[group(1), binding(0)]] var<uniform> model : Model;

    [[stage(vertex)]]
    fn main([[location(0)]] position : vec3<f32>) -> [[builtin(position)]] vec4<f32> {
        return scene.lightViewProjMatrix * model.transform * vec4<f32>(position, 1.0);
    }
`;
const fragmentShaderForShadows = `
    [[stage(fragment)]] fn main() { }
`;
const vertexShader = `
    ${shaderSceneStruct}

    [[block]] struct Model {
    ${MeshUniform.GenerateWGSLUniformStruct()}
    };

    [[group(0), binding(0)]] var<uniform> scene : Scene;
    [[group(1), binding(0)]] var<uniform> model : Model;
    // [[group(0), binding(3)]] var fsTexture: texture_2d<f32>;

    struct VertexOutput {
        ${vertexShaderOutput}
    };

    fn waterDisplace(pos: vec3<f32>) -> vec3<f32> {
        let t = scene.time * 0.004;
        let xt = pos.x + t;
        let zt = pos.z + t;
        let y = 0.0
            + sin(xt * 0.2)
            + cos((zt * 2.0 + xt) * 0.1) * 2.0
            + cos((zt * 0.5 + xt * 0.2) * 0.2) * 4.0
            + sin((xt * 0.5 + zt) * 0.9) * 0.2
            + sin((xt - zt * 0.5) * 0.7) * 0.1
            ;
        return vec3<f32>(0.0, y, 0.0);
    }

    // fn quantize(n: f32, step: f32) -> f32 {
    //     return floor(n / step) * step;
    // }

    [[stage(vertex)]]
    fn main(
        ${Vertex.GenerateWGSLVertexInputStruct(',')}
        ) -> VertexOutput {
        var output : VertexOutput;

        // // sample from displacement map
        // // let geometrySize: vec2<f32> = vec2<f32>(100.0, 100.0);
        // let geometrySize: vec2<f32> = (model.aabbMax - model.aabbMin).xz;
        // let fsSampleCoord = vec2<i32>(((position.xz - model.aabbMin.xz) / geometrySize) * vec2<f32>(textureDimensions(fsTexture)));
        // let fsSample : vec3<f32> = textureLoad(fsTexture, fsSampleCoord, 0).rgb;
        // let fsSampleQuant = vec3<f32>(quantize(fsSample.x, 0.1), quantize(fsSample.y, 0.1), quantize(fsSample.z, 0.1));
        let positionL: vec3<f32> = vec3<f32>(position.x - 1.0, position.y, position.z);
        let positionB: vec3<f32> = vec3<f32>(position.x, position.y, position.z - 1.0);
        var displacement: vec3<f32> = vec3<f32>(0.0);
        var displacementL: vec3<f32> = vec3<f32>(0.0);
        var displacementB: vec3<f32> = vec3<f32>(0.0);
        if (kind == 1u) {
            displacement = waterDisplace(position);
            displacementL = waterDisplace(positionL);
            displacementB = waterDisplace(positionB);
        }
        let dPos: vec3<f32> = position + displacement;
        let dPosL: vec3<f32> = positionL + displacementL;
        let dPosB: vec3<f32> = positionB + displacementB;

        var dNorm: vec3<f32> = normal;
        if (kind == 1u) {
            // const n = vec3.cross(vec3.create(), vec3.sub(vec3.create(), p2, p1), vec3.sub(vec3.create(), p3, p1))
            dNorm = normalize(cross(dPosB - dPos, dPosL - dPos));
            // dNorm = normalize(cross(dPos - dPosB, dPos - dPosL));
        }

        // var dPos2: vec3<f32>;

        // if (kind == 1u) {
        //     dPos2 = position + fsSample;
        //     // dPos2 = position + fsSampleQuant * 10.0;
        // } else {
        //     dPos2 = position;
        // }

        let worldPos: vec4<f32> = model.transform * vec4<f32>(dPos, 1.0);

        // XY is in (-1, 1) space, Z is in (0, 1) space
        let posFromLight : vec4<f32> = scene.lightViewProjMatrix * worldPos;
        // Convert XY to (0, 1), Y is flipped because texture coords are Y-down.
        output.shadowPos = vec3<f32>(
            posFromLight.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5),
            posFromLight.z
        );

        let worldNorm: vec4<f32> = normalize(model.transform * vec4<f32>(dNorm, 0.0));

        output.worldPos = worldPos.xyz;
        output.position = scene.cameraViewProjMatrix * worldPos;
        // let xyz = (output.position.xyz / output.position.w);
        // let xy = (xyz.xy / xyz.z);
        // // output.screenCoord = normalize(xy) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
        output.normal = worldNorm.xyz;
        // output.color = model.aabbMin + model.aabbMax;
        // output.color = model.aabbMax;
        // output.color = vec3<f32>(geometrySize.x, 0.0, geometrySize.y);
        output.color = color;
        // output.color = worldNorm.xyz;
        return output;
    }
`;
const fragmentShader = `
    ${shaderSceneStruct}

    [[group(0), binding(0)]] var<uniform> scene : Scene;
    [[group(0), binding(1)]] var shadowMap: texture_depth_2d;
    // TODO(@darzu): waiting on this sample to work again: http://austin-eng.com/webgpu-samples/samples/shadowMapping
    [[group(0), binding(2)]] var shadowSampler: sampler_comparison;
    [[group(0), binding(3)]] var fsTexture: texture_2d<f32>;
    [[group(0), binding(4)]] var samp : sampler;

    struct VertexOutput {
        ${vertexShaderOutput}
    };

    fn quantize(n: f32, step: f32) -> f32 {
        return floor(n / step) * step;
    }

    [[stage(fragment)]]
    fn main(input: VertexOutput) -> [[location(0)]] vec4<f32> {
        // let shadowVis : f32 = 1.0;
        let shadowVis : f32 = textureSampleCompare(shadowMap, shadowSampler, input.shadowPos.xy, input.shadowPos.z - 0.007);
        let sunLight : f32 = shadowVis * clamp(dot(-scene.lightDir, input.normal), 0.0, 1.0);

        // // TODO: test fs shader
        // // top left is 0,0
        // let screenCoordinates = input.position.xy / scene.targetSize;
        // let fsSampleCoord = screenCoordinates * vec2<f32>(textureDimensions(fsTexture));
        // // let fsSampleCoord = vec2<f32>(input.position.x, input.position.y);
        // let fsSample : vec3<f32> = textureSample(fsTexture, samp, screenCoordinates).rgb;
        // let fsSampleQuant = vec3<f32>(quantize(fsSample.x, 0.1), quantize(fsSample.y, 0.1), quantize(fsSample.z, 0.1));


        let resultColor: vec3<f32> = input.color * (sunLight * 2.0 + 0.2); // + fsSampleQuant * 0.2;
        let gammaCorrected: vec3<f32> = pow(resultColor, vec3<f32>(1.0/2.2));
        return vec4<f32>(gammaCorrected, 1.0);
    }
`;
// generates a texture
const vertexShaderForFS = `
    [[block]] struct Scene {
        time : f32;
    };

    struct VertexOutput {
        [[builtin(position)]] position: vec4<f32>;
        [[location(0)]] coordinate: vec2<f32>;
    };

    [[group(0), binding(0)]] var<uniform> scene : Scene;

    [[stage(vertex)]]
    fn main([[location(0)]] position : vec2<f32>) -> VertexOutput {
        // TODO:
        var output: VertexOutput;
        output.position = vec4<f32>(position, 0.0, 1.0);
        output.coordinate = position * 0.5 + 0.5;
        return output;
    }
`;
const fragmentShaderForFS = `
    struct VertexOutput {
        [[builtin(position)]] position: vec4<f32>;
        [[location(0)]] coordinate: vec2<f32>;
    };

    [[stage(fragment)]]
    fn main(
        input: VertexOutput
    ) -> [[location(0)]] vec4<f32> {
        let r = input.coordinate.x;
        let g = input.coordinate.y;
        let b = 0.0;
        return vec4<f32>(r, g, b, 1.0);
     }
`;
const computeForFS = `
  [[block]] struct Scene {
    time : f32;
  };

  [[group(0), binding(0)]] var<uniform> scene : Scene;
  [[group(0), binding(1)]] var output : texture_storage_2d<rgba8unorm, write>;

  // TODO: try workgroup data
  // var<workgroup> tile : array<array<vec3<f32>, 256>, 4>;

  fn waterDisplace(pos: vec3<f32>) -> vec3<f32> {
    let t = scene.time * 0.004;
    let xt = pos.x + t;
    let zt = pos.z + t;
    let y = 0.0
        + sin(xt * 0.2)
        + cos((zt * 2.0 + xt) * 0.1) * 2.0
        + cos((zt * 0.5 + xt * 0.2) * 0.2) * 4.0
        + sin((xt * 0.5 + zt) * 0.9) * 0.2
        + sin((xt - zt * 0.5) * 0.7) * 0.1
        ;
    return vec3<f32>(0.0, y, 0.0);
}

  [[stage(compute), workgroup_size(8, 8, 1)]]
  fn main(
    [[builtin(workgroup_id)]] groupId : vec3<u32>,
    [[builtin(local_invocation_id)]] localId : vec3<u32>,
    [[builtin(global_invocation_id)]] globalId : vec3<u32>
  ) {
    let dims : vec2<i32> = vec2<i32>(textureDimensions(output));

    let col: u32 = (groupId.x * 8u) + localId.x;
    let row: u32 = (groupId.y * 8u) + localId.y;
    let coord = vec2<i32>(i32(col), i32(row));

    let x = f32(col) / f32(dims.x);
    let y = f32(row) / f32(dims.y);
    let z = 0.0;

    let pos = vec3<f32>(f32(col), f32(row), z);

    // let height = y;
    let height = waterDisplace(pos).y;

    let res = vec4<f32>(0.0, height, 0.0, 1.0);

    textureStore(output, coord, res);
  }
`;
// useful constants
const bytesPerFloat = Float32Array.BYTES_PER_ELEMENT;
// render pipeline parameters
const antiAliasSampleCount = 4;
const swapChainFormat = 'bgra8unorm';
const depthStencilFormat = 'depth24plus-stencil8';
const shadowDepthStencilFormat = 'depth32float';
const backgroundColor = { r: 0.5, g: 0.5, b: 0.5, a: 1.0 };
// this state is recomputed upon canvas resize
let depthTexture;
let depthTextureView;
let colorTexture;
let colorTextureView;
let lastWidth = 0;
let lastHeight = 0;
let aspectRatio = 1;
// recomputes textures, widths, and aspect ratio on canvas resize
function checkCanvasResize(device, canvasWidth, canvasHeight) {
    if (lastWidth === canvasWidth && lastHeight === canvasHeight)
        return;
    if (depthTexture)
        depthTexture.destroy();
    if (colorTexture)
        colorTexture.destroy();
    depthTexture = device.createTexture({
        size: { width: canvasWidth, height: canvasHeight },
        format: depthStencilFormat,
        sampleCount: antiAliasSampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depthTextureView = depthTexture.createView();
    colorTexture = device.createTexture({
        size: { width: canvasWidth, height: canvasHeight },
        sampleCount: antiAliasSampleCount,
        format: swapChainFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    ;
    colorTextureView = colorTexture.createView();
    lastWidth = canvasWidth;
    lastHeight = canvasHeight;
    aspectRatio = Math.abs(canvasWidth / canvasHeight);
}
// define our meshes (ideally these would be imported from a standard format)
export const CUBE = unshareProvokingVertices({
    pos: [
        [+1.0, +1.0, +1.0],
        [-1.0, +1.0, +1.0],
        [-1.0, -1.0, +1.0],
        [+1.0, -1.0, +1.0],
        [+1.0, +1.0, -1.0],
        [-1.0, +1.0, -1.0],
        [-1.0, -1.0, -1.0],
        [+1.0, -1.0, -1.0],
    ],
    tri: [
        [0, 1, 2], [0, 2, 3],
        [4, 5, 1], [4, 1, 0],
        [3, 4, 0], [3, 7, 4],
        [2, 1, 5], [2, 5, 6],
        [6, 3, 2], [6, 7, 3],
        [5, 4, 7], [5, 7, 6], // back
    ],
    colors: [
        [0.2, 0, 0], [0.2, 0, 0],
        [0.2, 0, 0], [0.2, 0, 0],
        [0.2, 0, 0], [0.2, 0, 0],
        [0.2, 0, 0], [0.2, 0, 0],
        [0.2, 0, 0], [0.2, 0, 0],
        [0.2, 0, 0], [0.2, 0, 0], // back
    ],
});
const PLANE = unshareProvokingVertices({
    pos: [
        [+1, 0, +1],
        [-1, 0, +1],
        [+1, 0, -1],
        [-1, 0, -1],
    ],
    tri: [
        [0, 2, 3], [0, 3, 1],
        [3, 2, 0], [1, 3, 0], // bottom
    ],
    colors: [
        [0.02, 0.02, 0.02], [0.02, 0.02, 0.02],
        [0.02, 0.02, 0.02], [0.02, 0.02, 0.02],
    ],
});
function createScene() {
    // create a directional light and compute it's projection (for shadows) and direction
    const worldOrigin = vec3.fromValues(0, 0, 0);
    const lightPosition = vec3.fromValues(50, 50, 0);
    const upVector = vec3.fromValues(0, 1, 0);
    const lightViewMatrix = mat4.lookAt(mat4.create(), lightPosition, worldOrigin, upVector);
    const lightProjectionMatrix = mat4.ortho(mat4.create(), -80, 80, -80, 80, -200, 300);
    const lightViewProjMatrix = mat4.multiply(mat4.create(), lightProjectionMatrix, lightViewMatrix);
    const lightDir = vec3.subtract(vec3.create(), worldOrigin, lightPosition);
    vec3.normalize(lightDir, lightDir);
    return {
        lightViewProjMatrix,
        lightDir,
    };
}
const scene = createScene();
const scratch_sceneuniform_u8 = new Uint8Array(SceneUniform.ByteSizeAligned);
function updateSceneUniform(device, buffer, data) {
    SceneUniform.Serialize(scratch_sceneuniform_u8, 0, data);
    device.queue.writeBuffer(buffer, 0, scratch_sceneuniform_u8);
}
function attachToCanvas(canvasRef, device) {
    // configure our canvas backed swapchain
    const context = canvasRef.getContext('webgpu');
    context.configure({ device, format: swapChainFormat });
    // create our scene's uniform buffer
    const sceneUniBuffer = device.createBuffer({
        size: SceneUniform.ByteSizeAligned,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // create our scene's uniform local data
    const sceneUni = {
        cameraViewProjMatrix: mat4.create(),
        lightViewProjMatrix: scene.lightViewProjMatrix,
        lightDir: scene.lightDir,
        time: 0.0,
        targetSize: [canvasRef.width, canvasRef.height],
        cameraPos: vec3.create(), // updated later
    };
    // setup a binding for our per-mesh uniforms
    const modelUniBindGroupLayout = device.createBindGroupLayout({
        entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MeshUniform.ByteSizeAligned },
            }],
    });
    const poolBuilder = createMeshPoolBuilder_WebGPU(device, {
        maxMeshes: 100,
        maxTris: 300,
        maxVerts: 900
    });
    // TODO(@darzu): adding via pool should work...
    const ground = poolBuilder.addMesh(PLANE);
    const player = poolBuilder.addMesh(CUBE);
    const randomCubes = [];
    // const NUM_CUBES = 1;
    const NUM_CUBES = 10;
    for (let i = 0; i < NUM_CUBES; i++) {
        // create cubes with random colors
        const color = [Math.random(), Math.random(), Math.random()];
        const coloredCube = { ...CUBE, colors: CUBE.colors.map(_ => color) };
        randomCubes.push(poolBuilder.addMesh(coloredCube));
    }
    const pool = poolBuilder.finish();
    const poolUniBindGroup = device.createBindGroup({
        layout: modelUniBindGroupLayout,
        entries: [{
                binding: 0,
                resource: { buffer: pool.uniformBuffer, size: MeshUniform.ByteSizeAligned, },
            }],
    });
    // place the ground
    mat4.translate(ground.transform, ground.transform, [0, -3, -8]);
    mat4.scale(ground.transform, ground.transform, [10, 10, 10]);
    pool.updateUniform(ground);
    // initialize our cubes; each will have a random axis of rotation
    const randomCubesAxis = [];
    for (let m of randomCubes) {
        // place and rotate cubes randomly
        mat4.translate(m.transform, m.transform, [Math.random() * 20 - 10, Math.random() * 5, -Math.random() * 10 - 5]);
        const axis = vec3.normalize(vec3.create(), [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
        randomCubesAxis.push(axis);
        pool.updateUniform(m);
        // TODO(@darzu): debug
        // meshApplyMinMaxPos(m);
    }
    const builderBuilder = (opts) => createMeshPoolBuilder_WebGPU(device, opts);
    // init grass
    const grass = initGrassSystem(builderBuilder);
    // init water
    const water = createWaterSystem(builderBuilder);
    // track which keys are pressed for use in the game loop
    const pressedKeys = {};
    window.addEventListener('keydown', (ev) => pressedKeys[ev.key.toLowerCase()] = true, false);
    window.addEventListener('keyup', (ev) => pressedKeys[ev.key.toLowerCase()] = false, false);
    // track mouse movement for use in the game loop
    let _mouseAccumulatedX = 0;
    let _mouseAccummulatedY = 0;
    window.addEventListener('mousemove', (ev) => {
        _mouseAccumulatedX += ev.movementX;
        _mouseAccummulatedY += ev.movementY;
    }, false);
    function takeAccumulatedMouseMovement() {
        const result = { x: _mouseAccumulatedX, y: _mouseAccummulatedY };
        _mouseAccumulatedX = 0; // reset accumulators
        _mouseAccummulatedY = 0;
        return result;
    }
    // when the player clicks on the canvas, lock the cursor for better gaming (the browser lets them exit)
    function doLockMouse() {
        canvasRef.requestPointerLock();
        canvasRef.removeEventListener('click', doLockMouse);
    }
    canvasRef.addEventListener('click', doLockMouse);
    // create the "player", which is an affine matrix tracking position & orientation of a cube
    // the camera will follow behind it.
    const cameraOffset = mat4.create();
    pitch(cameraOffset, -Math.PI / 8);
    // mat4.rotateY(player.transform, player.transform, Math.PI * 1.25)
    pool.updateUniform(player);
    // we'll use a triangle list with backface culling and counter-clockwise triangle indices for both pipelines
    const primitiveBackcull = {
        topology: 'triangle-list',
        cullMode: 'none',
        // cullMode: 'back', 
        frontFace: 'ccw',
    };
    // TODO(@darzu): trying to extract the shadow pipeline
    let shadowBundle;
    let shadowDepthTextureView;
    {
        // define the resource bindings for the shadow pipeline
        const shadowSceneUniBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });
        const shadowSceneUniBindGroup = device.createBindGroup({
            layout: shadowSceneUniBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: sceneUniBuffer } }
            ],
        });
        // create the texture that our shadow pass will render to
        const shadowDepthTextureDesc = {
            size: { width: 2048 * 2, height: 2048 * 2 },
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.SAMPLED,
            format: shadowDepthStencilFormat,
        };
        const shadowDepthTexture = device.createTexture(shadowDepthTextureDesc);
        shadowDepthTextureView = shadowDepthTexture.createView();
        // setup our first phase pipeline which tracks the depth of meshes 
        // from the point of view of the lighting so we know where the shadows are
        const shadowPipelineDesc = {
            layout: device.createPipelineLayout({
                bindGroupLayouts: [shadowSceneUniBindGroupLayout, modelUniBindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: vertexShaderForShadows }),
                entryPoint: 'main',
                buffers: [{
                        arrayStride: Vertex.ByteSize,
                        attributes: Vertex.WebGPUFormat,
                    }],
            },
            fragment: {
                module: device.createShaderModule({ code: fragmentShaderForShadows }),
                entryPoint: 'main',
                targets: [],
            },
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: shadowDepthStencilFormat,
            },
            primitive: primitiveBackcull,
        };
        const shadowPipeline = device.createRenderPipeline(shadowPipelineDesc);
        // record all the draw calls we'll need in a bundle which we'll replay during the render loop each frame.
        // This saves us an enormous amount of JS compute. We need to rebundle if we add/remove meshes.
        const shadowBundleEnc = device.createRenderBundleEncoder({
            colorFormats: [],
            depthStencilFormat: shadowDepthStencilFormat,
        });
        shadowBundleEnc.setPipeline(shadowPipeline);
        shadowBundleEnc.setBindGroup(0, shadowSceneUniBindGroup);
        shadowBundleEnc.setVertexBuffer(0, pool.verticesBuffer);
        shadowBundleEnc.setIndexBuffer(pool.indicesBuffer, 'uint16');
        for (let m of pool.allMeshes) {
            shadowBundleEnc.setBindGroup(1, poolUniBindGroup, [m.modelUniByteOffset]);
            shadowBundleEnc.drawIndexed(m.numTris * 3, undefined, m.indicesNumOffset, m.vertNumOffset);
        }
        shadowBundle = shadowBundleEnc.finish();
    }
    // TODO(@darzu): trying to extract the shadow pipeline
    let fsUniBuffer;
    let fsBundle;
    let fsTextureView;
    {
        const width = 2048;
        const height = 2048;
        // TODO(@darzu): FS SCENE FORMAT
        const fsUniBufferSizeExact = 0
            + bytesPerFloat * 1; // time
        const fsUniBufferSizeAligned = align(fsUniBufferSizeExact, 256); // uniform objects must be 256 byte aligned
        fsUniBuffer = device.createBuffer({
            size: fsUniBufferSizeAligned,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const fsSceneUniBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });
        const fsSceneUniBindGroup = device.createBindGroup({
            layout: fsSceneUniBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: fsUniBuffer } }
            ],
        });
        const fsColorFormat = 'bgra8unorm'; // rgba8unorm
        const fsTextureDesc = {
            size: { width, height },
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.SAMPLED,
            format: fsColorFormat, // TODO(@darzu): which format?
        };
        const fsDepthTexture = device.createTexture(fsTextureDesc);
        fsTextureView = fsDepthTexture.createView();
        const fsVertByteSize = bytesPerFloat * 2; // TODO(@darzu): FS VERTEX FORMAT
        const fsVertexDataFormat = [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
        ];
        const fsPipelineDesc = {
            layout: device.createPipelineLayout({
                bindGroupLayouts: [fsSceneUniBindGroupLayout],
            }),
            vertex: {
                module: device.createShaderModule({ code: vertexShaderForFS }),
                entryPoint: 'main',
                buffers: [{
                        arrayStride: fsVertByteSize,
                        attributes: fsVertexDataFormat,
                    }],
            },
            fragment: {
                module: device.createShaderModule({ code: fragmentShaderForFS }),
                entryPoint: 'main',
                targets: [{ format: fsColorFormat }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',
                frontFace: 'ccw',
            },
        };
        const numVerts = 6;
        const fsVerticesBuffer = device.createBuffer({
            size: numVerts * fsVertByteSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
        });
        {
            // TODO(@darzu): 
            // var uv = array<vec2<f32>, 6>(
            //     vec2<f32>(1.0, 0.0),
            //     vec2<f32>(1.0, 1.0),
            //     vec2<f32>(0.0, 1.0),
            //     vec2<f32>(1.0, 0.0),
            //     vec2<f32>(0.0, 1.0),
            //     vec2<f32>(0.0, 0.0));
            const fsVertsMap = new Float32Array(fsVerticesBuffer.getMappedRange());
            fsVertsMap.set([
                ...[1.0, 1.0],
                ...[1.0, -1.0],
                ...[-1.0, -1.0],
                ...[1.0, 1.0],
                ...[-1.0, -1.0],
                ...[-1.0, 1.0],
            ]);
        }
        // TODO(@darzu): set verts
        fsVerticesBuffer.unmap();
        const fsPipeline = device.createRenderPipeline(fsPipelineDesc);
        const fsBundleEnc = device.createRenderBundleEncoder({
            colorFormats: [fsColorFormat],
        });
        fsBundleEnc.setPipeline(fsPipeline);
        fsBundleEnc.setBindGroup(0, fsSceneUniBindGroup);
        fsBundleEnc.setVertexBuffer(0, fsVerticesBuffer);
        fsBundleEnc.draw(numVerts);
        fsBundle = fsBundleEnc.finish();
    }
    // // our compute pipeline for generating a texture
    // const computeTexWidth = 2048;
    // const computeTexHeight = 2048;
    // const computeGroupSize = 8; // TODO(@darzu): is this needed?
    // let computeTextureView: GPUTextureView;
    // let computeSceneBuffer: GPUBuffer;
    // let computePipeline: GPUComputePipeline;
    // let computeBindGroup: GPUBindGroup;
    // {
    //     computePipeline = device.createComputePipeline({
    //         compute: {
    //             module: device.createShaderModule({
    //                 code: computeForFS,
    //             }),
    //             entryPoint: 'main',
    //         },
    //     });
    //     const computeSceneSizeExact = bytesPerFloat * 1; // time
    //     computeSceneBuffer = device.createBuffer({
    //         size: computeSceneSizeExact,
    //         usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    //     });
    //     const computeColorFormat: GPUTextureFormat = 'rgba8unorm'; // rgba8unorm
    //     const computeTextureDesc: GPUTextureDescriptor = {
    //         size: { width: computeTexWidth, height: computeTexHeight },
    //         usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE | GPUTextureUsage.SAMPLED,
    //         format: computeColorFormat, // TODO(@darzu): which format?
    //     }
    //     const computeTexture = device.createTexture(computeTextureDesc);
    //     computeTextureView = computeTexture.createView();
    //     computeBindGroup = device.createBindGroup({
    //         layout: computePipeline.getBindGroupLayout(0),
    //         entries: [
    //             { binding: 0, resource: { buffer: computeSceneBuffer } },
    //             { binding: 1, resource: computeTextureView },
    //         ],
    //     });
    // }
    // setup our second phase pipeline which renders meshes to the canvas
    const renderSceneUniBindGroupLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
            { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
            // TODO(@darzu): testing fullscreen shader
            { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
    });
    const renderSceneUniBindGroup = device.createBindGroup({
        layout: renderSceneUniBindGroupLayout,
        entries: [
            { binding: 0, resource: { buffer: sceneUniBuffer } },
            { binding: 1, resource: shadowDepthTextureView },
            { binding: 2, resource: device.createSampler({ compare: 'less' }) },
            { binding: 3, resource: fsTextureView },
            // { binding: 3, resource: computeTextureView },
            {
                binding: 4, resource: device.createSampler({
                    magFilter: 'linear',
                    minFilter: 'linear',
                })
            },
        ],
    });
    const renderPipelineDesc = {
        layout: device.createPipelineLayout({
            bindGroupLayouts: [renderSceneUniBindGroupLayout, modelUniBindGroupLayout],
        }),
        vertex: {
            module: device.createShaderModule({ code: vertexShader }),
            entryPoint: 'main',
            buffers: [{
                    arrayStride: Vertex.ByteSize,
                    attributes: Vertex.WebGPUFormat,
                }],
        },
        fragment: {
            module: device.createShaderModule({ code: fragmentShader }),
            entryPoint: 'main',
            targets: [{ format: swapChainFormat }],
        },
        primitive: primitiveBackcull,
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: depthStencilFormat,
        },
        multisample: {
            count: antiAliasSampleCount,
        },
    };
    const renderPipeline = device.createRenderPipeline(renderPipelineDesc);
    const bundleEnc = device.createRenderBundleEncoder({
        colorFormats: [swapChainFormat],
        depthStencilFormat: depthStencilFormat,
        sampleCount: antiAliasSampleCount,
    });
    bundleEnc.setPipeline(renderPipeline);
    bundleEnc.setBindGroup(0, renderSceneUniBindGroup);
    // TODO(@darzu): change for webgl vs webgpu
    const pools = [pool, ...grass.getGrassPools(), ...water.getMeshPools()];
    for (let p of pools) {
        // TODO(@darzu): not super happy about these being created during bundle time...
        const modelUniBindGroup = device.createBindGroup({
            layout: modelUniBindGroupLayout,
            entries: [{
                    binding: 0,
                    resource: { buffer: p.uniformBuffer, size: MeshUniform.ByteSizeAligned, },
                }],
        });
        bundleEnc.setVertexBuffer(0, p.verticesBuffer);
        bundleEnc.setIndexBuffer(p.indicesBuffer, 'uint16');
        console.log("rendering: " + p.allMeshes.length);
        for (let m of p.allMeshes) {
            bundleEnc.setBindGroup(1, modelUniBindGroup, [m.modelUniByteOffset]);
            bundleEnc.drawIndexed(m.numTris * 3, undefined, m.indicesNumOffset, m.vertNumOffset);
        }
    }
    let renderBundle = bundleEnc.finish();
    // initialize performance metrics
    let debugDiv = document.getElementById('debug-div');
    let previousFrameTime = 0;
    let avgJsTimeMs = 0;
    let avgFrameTimeMs = 0;
    // controls for this demo
    const controlsStr = `controls: WASD, shift/c, mouse, spacebar`;
    // our main game loop
    function renderFrame(timeMs) {
        // track performance metrics
        const start = performance.now();
        const frameTimeMs = previousFrameTime ? timeMs - previousFrameTime : 0;
        previousFrameTime = timeMs;
        // resize (if necessary)
        checkCanvasResize(device, canvasRef.width, canvasRef.height);
        sceneUni.targetSize = [canvasRef.width, canvasRef.height];
        // process inputs and move the player & camera
        const playerSpeed = pressedKeys[' '] ? 1.0 : 0.2; // spacebar boosts speed
        if (pressedKeys['w'])
            moveZ(player.transform, -playerSpeed); // forward
        if (pressedKeys['s'])
            moveZ(player.transform, playerSpeed); // backward
        if (pressedKeys['a'])
            moveX(player.transform, -playerSpeed); // left
        if (pressedKeys['d'])
            moveX(player.transform, playerSpeed); // right
        if (pressedKeys['shift'])
            moveY(player.transform, playerSpeed); // up
        if (pressedKeys['c'])
            moveY(player.transform, -playerSpeed); // down
        const { x: mouseX, y: mouseY } = takeAccumulatedMouseMovement();
        yaw(player.transform, -mouseX * 0.01);
        pitch(cameraOffset, -mouseY * 0.01);
        // apply the players movement by writting to the model uniform buffer
        pool.updateUniform(player);
        // calculate and write our view and project matrices
        const viewLocMatrix = mat4.create();
        mat4.multiply(viewLocMatrix, viewLocMatrix, player.transform);
        mat4.multiply(viewLocMatrix, viewLocMatrix, cameraOffset);
        mat4.translate(viewLocMatrix, viewLocMatrix, [0, 0, 10]); // TODO(@darzu): can this be merged into the camera offset?
        const viewMatrix = mat4.invert(mat4.create(), viewLocMatrix);
        const projectionMatrix = mat4.perspective(mat4.create(), (2 * Math.PI) / 5, aspectRatio, 1, 10000.0 /*view distance*/);
        mat4.multiply(sceneUni.cameraViewProjMatrix, projectionMatrix, viewMatrix);
        // rotate the random cubes
        for (let i = 0; i < randomCubes.length; i++) {
            const m = randomCubes[i];
            const axis = randomCubesAxis[i];
            mat4.rotate(m.transform, m.transform, Math.PI * 0.01, axis);
            pool.updateUniform(m);
        }
        // update grass
        const playerPos = getPositionFromTransform(player.transform);
        grass.update(playerPos);
        // update scene data
        sceneUni.time = timeMs;
        // TODO(@darzu): is this the camera position? seems off in the shader...
        sceneUni.cameraPos = getPositionFromTransform(viewLocMatrix);
        // send scene uniform data to GPU
        updateSceneUniform(device, sceneUniBuffer, sceneUni);
        // update fullscreen scene data
        const fsUniTimeOffset = 0;
        const fsTimeBuffer = new Float32Array(1);
        fsTimeBuffer[0] = timeMs;
        device.queue.writeBuffer(fsUniBuffer, fsUniTimeOffset, fsTimeBuffer);
        // start our rendering passes
        const commandEncoder = device.createCommandEncoder();
        // // do compute pass(es)
        // {
        //     const computePass = commandEncoder.beginComputePass();
        //     computePass.setPipeline(computePipeline);
        //     computePass.setBindGroup(0, computeBindGroup);
        //     computePass.dispatch(
        //         Math.ceil(computeTexWidth / computeGroupSize),
        //         Math.ceil(computeTexHeight / computeGroupSize)
        //     );
        //     computePass.endPass();
        // }
        // TODO(@darzu): render fullscreen pipeline
        const fsRenderPassEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                    view: fsTextureView,
                    loadValue: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
                    storeOp: 'store',
                }],
        });
        fsRenderPassEncoder.executeBundles([fsBundle]);
        fsRenderPassEncoder.endPass();
        // render from the light's point of view to a depth buffer so we know where shadows are
        const shadowRenderPassEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [],
            depthStencilAttachment: {
                view: shadowDepthTextureView,
                depthLoadValue: 1.0,
                depthStoreOp: 'store',
                stencilLoadValue: 0,
                stencilStoreOp: 'store',
            },
        });
        shadowRenderPassEncoder.executeBundles([shadowBundle]);
        shadowRenderPassEncoder.endPass();
        // render to the canvas' via our swap-chain
        const renderPassEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                    view: colorTextureView,
                    resolveTarget: context.getCurrentTexture().createView(),
                    loadValue: backgroundColor,
                    storeOp: 'store',
                }],
            depthStencilAttachment: {
                view: depthTextureView,
                depthLoadValue: 1.0,
                depthStoreOp: 'store',
                stencilLoadValue: 0,
                stencilStoreOp: 'store',
            },
        });
        renderPassEncoder.executeBundles([renderBundle]);
        renderPassEncoder.endPass();
        // submit render passes to GPU
        device.queue.submit([commandEncoder.finish()]);
        // calculate performance metrics as running, weighted averages across frames
        const jsTime = performance.now() - start;
        const avgWeight = 0.05;
        avgJsTimeMs = avgJsTimeMs ? (1 - avgWeight) * avgJsTimeMs + avgWeight * jsTime : jsTime;
        avgFrameTimeMs = avgFrameTimeMs ? (1 - avgWeight) * avgFrameTimeMs + avgWeight * frameTimeMs : frameTimeMs;
        const avgFPS = 1000 / avgFrameTimeMs;
        debugDiv.innerText = controlsStr
            + `\n` + `(js per frame: ${avgJsTimeMs.toFixed(2)}ms, fps: ${avgFPS.toFixed(1)})`;
    }
    return renderFrame;
}
async function main() {
    const start = performance.now();
    // attach to HTML canvas 
    let canvasRef = document.getElementById('sample-canvas');
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    // resize the canvas when the window resizes
    function onWindowResize() {
        canvasRef.width = window.innerWidth;
        canvasRef.style.width = `${window.innerWidth}px`;
        canvasRef.height = window.innerHeight;
        canvasRef.style.height = `${window.innerHeight}px`;
    }
    window.onresize = function () {
        onWindowResize();
    };
    onWindowResize();
    // build our scene for the canvas
    const renderFrame = attachToCanvas(canvasRef, device);
    console.log(`JS init time: ${(performance.now() - start).toFixed(1)}ms`);
    // run our game loop using 'requestAnimationFrame`
    if (renderFrame) {
        const _renderFrame = (time) => {
            renderFrame(time);
            requestAnimationFrame(_renderFrame);
        };
        requestAnimationFrame(_renderFrame);
    }
}
await main();
//# sourceMappingURL=sprig-main.js.map