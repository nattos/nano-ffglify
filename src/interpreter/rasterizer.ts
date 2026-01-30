import { EvaluationContext, RuntimeValue } from './context';
import { InterpretedExecutor } from './executor';
import { FunctionDef, RenderPipelineDef } from '../ir/types';

/**
 * Software Rasterizer for the Reference Interpreter.
 * Implements a simple scanline rasterizer to support cmd_draw.
 */
export class SoftwareRasterizer {
  private context: EvaluationContext;
  private executor: InterpretedExecutor;

  constructor(context: EvaluationContext) {
    this.context = context;
    // We create a dedicated executor to avoid messing with the main stack if needed,
    // though here we likely want shared state.
    this.executor = new (InterpretedExecutor as any)(context);
  }

  /**
   * Execute a draw command.
   */
  draw(
    targetId: string,
    vertexId: string,
    fragmentId: string,
    vertexCount: number,
    pipeline: RenderPipelineDef
  ) {
    const target = this.context.getResource(targetId);
    if (!target) throw new Error(`Rasterizer: Target '${targetId}' not found`);

    const vs = this.context.ir.functions.find(f => f.id === vertexId);
    const fs = this.context.ir.functions.find(f => f.id === fragmentId);

    if (!vs || !fs) throw new Error(`Rasterizer: Shaders not found (${vertexId}, ${fragmentId})`);

    const width = target.width;
    const height = target.height;

    // 1. Vertex Shader Stage
    const vertices: any[] = [];
    for (let i = 0; i < vertexCount; i++) {
      this.context.pushFrame(vertexId);
      // Builtins - Map both by builtin name (for builtin nodes) and by input ID (for var_get)
      this.context.builtins.set('vertex_index', i);
      this.context.builtins.set('instance_index', 0);

      if (vs.inputs) {
        for (const input of vs.inputs) {
          if (input.builtin === 'vertex_index') this.context.setVar(input.id, i);
          if (input.builtin === 'instance_index') this.context.setVar(input.id, 0);
        }
      }

      const result = this.executor.executeFunction(vs);
      this.context.popFrame();
      vertices.push(result);
    }

    // 2. Rasterization Stage
    // We only support triangle-list for now.
    if (pipeline.topology !== 'triangle-list' && pipeline.topology !== undefined) {
      throw new Error(`Rasterizer: Unsupported topology '${pipeline.topology}'`);
    }

    for (let i = 0; i < vertices.length; i += 3) {
      this.drawTriangle(vertices[i], vertices[i + 1], vertices[i + 2], fs, target);
    }
  }

  private drawTriangle(v0: any, v1: any, v2: any, fs: FunctionDef, target: any) {
    // 1. Resolve Position Member
    // VS output (VertexOutput) has a member with @builtin(position)
    if (!v0 || !v1 || !v2) throw new Error(`Rasterizer: Vertex shader returned undefined result`);
    const vsOutputStructId = (v0 as any)._type || fs.inputs[0]?.type;
    const structDef = this.context.ir.structs?.find(s => s.id === vsOutputStructId);
    let posKey = 'position';
    if (structDef) {
      const posMember = structDef.members.find(m => m.builtin === 'position');
      if (posMember) posKey = posMember.name;
    } else {
      // Fallback for simple cases if struct info is missing
      if (v0.position) posKey = 'position';
      else if (v0.pos) posKey = 'pos';
    }

    const p0 = v0[posKey] as number[];
    const p1 = v1[posKey] as number[];
    const p2 = v2[posKey] as number[];

    // Convert Clip Space -> Screen Space
    const toScreen = (p: number[]) => ({
      x: (p[0] / p[3] * 0.5 + 0.5) * target.width,
      y: (0.5 - p[1] / p[3] * 0.5) * target.height, // Flip Y for screen space
      z: p[2] / p[3],
      w: p[3]
    });

    const s0 = toScreen(p0);
    const s1 = toScreen(p1);
    const s2 = toScreen(p2);

    // Bounding Box
    const minX = Math.floor(Math.min(s0.x, s1.x, s2.x));
    const maxX = Math.ceil(Math.max(s0.x, s1.x, s2.x));
    const minY = Math.floor(Math.min(s0.y, s1.y, s2.y));
    const maxY = Math.ceil(Math.max(s0.y, s1.y, s2.y));

    // Clamp to target
    const xStart = Math.max(0, minX);
    const xEnd = Math.min(target.width - 1, maxX);
    const yStart = Math.max(0, minY);
    const yEnd = Math.min(target.height - 1, maxY);

    for (let y = yStart; y <= yEnd; y++) {
      for (let x = xStart; x <= xEnd; x++) {
        const px = x + 0.5;
        const py = y + 0.5;

        // Barycentric Coordinates
        const w = this.edgeFunc(s0, s1, { x: px, y: py });
        const u = this.edgeFunc(s1, s2, { x: px, y: py });
        const v = this.edgeFunc(s2, s0, { x: px, y: py });

        // Support both windings (CCW is positive, CW is negative)
        if ((u >= 0 && v >= 0 && w >= 0) || (u <= 0 && v <= 0 && w <= 0)) {
          const area = this.edgeFunc(s0, s1, s2);
          if (Math.abs(area) < 1e-6) continue;

          const bu = u / area;
          const bv = v / area;
          const bw = w / area;

          // Interpolate Varyings
          const interpolated: any = {};
          for (const key in v0) {
            if (key === 'position') continue;
            interpolated[key] = this.interpolate(v0[key], v1[key], v2[key], bu, bv, bw);
          }

          // Fragment Shader
          this.context.pushFrame(fs.id);
          // Set interpolated varyings as inputs to FS
          // If the FS has a struct input that matches the VS output struct, pass the whole interpolated object
          if (fs.inputs && fs.inputs.length === 1 && this.context.ir.structs?.some(s => s.id === fs.inputs[0].type)) {
            this.context.setVar(fs.inputs[0].id, interpolated);
          } else if (fs.inputs) {
            for (const input of fs.inputs) {
              const val = interpolated[input.id];
              if (val !== undefined) this.context.setVar(input.id, val);
            }
          }

          const result = this.executor.executeFunction(fs);
          const color = (result || [0, 0, 0, 0]) as number[];
          this.context.popFrame();

          // Write to target
          const idx = y * target.width + x;
          target.data[idx] = color;
        }
      }
    }
  }

  private edgeFunc(a: any, b: any, p: any) {
    return (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  }

  private interpolate(a: any, b: any, c: any, bu: number, bv: number, bw: number) {
    if (typeof a === 'number') {
      return a * bu + b * bv + c * bw;
    }
    if (Array.isArray(a)) {
      return a.map((v, i) => v * bu + b[i] * bv + c[i] * bw);
    }
    return a;
  }
}
