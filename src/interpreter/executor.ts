import { IRDocument, FunctionDef, Node, Edge } from '../ir/types';
import { EvaluationContext, RuntimeValue } from './context';
import { OpRegistry } from './ops';

export class CpuExecutor {
  constructor(private context: EvaluationContext) { }

  executeEntry() {
    this.executeFunction(this.context.ir.entryPoint);
  }

  executeFunction(funcId: string, args: RuntimeValue[] = []): RuntimeValue | void {
    const func = this.context.ir.functions.find(f => f.id === funcId);
    if (!func) throw new Error(`Function '${funcId}' not found`);

    // Only 'cpu' and 'shader' are supported.
    // We allow executing 'shader' functions now for simulation.

    // 1. Push Scope
    this.context.pushFrame(funcId);

    // 2. Initialize Local Vars & Args
    // Args mapping? For now assume args are handled via inputs/globals or manual set if we implemented arguments.
    // IR v3 FunctionDef has `inputs` port defs. Logic would go here to map `args` to `localVars` or similar.
    // For now, just init localVars definitions.
    func.localVars.forEach(v => {
      if (v.initialValue !== undefined) this.context.setVar(v.id, v.initialValue);
    });

    // 3. Find entry nodes
    // Nodes with NO incoming execution edges.
    const entryNodes = func.nodes.filter(n => {
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutableNode(n);
    });

    // 4. Run
    for (const node of entryNodes) {
      this.executeNode(node, func);
    }

    // 5. Pop Scope
    this.context.popFrame();
  }

  private isExecutableNode(node: Node): boolean {
    // Op-codes that potentially start chains
    return node.op.startsWith('cmd_') ||
      node.op.startsWith('flow_') ||
      node.op.startsWith('var_set') ||
      node.op.startsWith('buffer_store') ||
      node.op.startsWith('texture_store');
  }

  private executeNode(node: Node, func: FunctionDef) {
    // 1. Resolve Inputs (eagerly)
    const args: Record<string, RuntimeValue> = {};
    const inputEdges = func.edges.filter(e => e.to === node.id && e.type === 'data');
    for (const edge of inputEdges) {
      const portName = edge.portIn;
      const sourceNode = func.nodes.find(n => n.id === edge.from);
      if (sourceNode) {
        args[portName] = this.resolveNodeValue(sourceNode, func, edge.portOut);
      }
    }

    // Mixin properties
    this.mixinNodeProperties(node, args);

    // 2. Execute Logic

    // --- Control Flow: Branch ---
    if (node.op === 'flow_branch') {
      const cond = args['cond'] as boolean;
      const branchPort = cond ? 'exec_true' : 'exec_false';
      this.continueFlow(node, branchPort, func);
      return;
    }
    // --- Control Flow: Loop ---
    else if (node.op === 'flow_loop') {
      const start = args['start'] as number;
      const end = args['end'] as number;
      for (let i = start; i < end; i++) {
        this.context.setLoopIndex(node.id, i);
        this.continueFlow(node, 'exec_body', func);
      }
      this.continueFlow(node, 'exec_completed', func);
      return;
    }
    // --- Command: Dispatch (SIMULATION) ---
    else if (node.op === 'cmd_dispatch') {
      const funcId = args.func as string || node.func; // Can be in args or prop

      let dispatch = args.dispatch as [number, number, number];
      if (!dispatch) dispatch = node.dispatch as [number, number, number] || [1, 1, 1];

      this.context.logAction('dispatch', funcId, { dispatch });

      // Simulating the Loop
      const [dx, dy, dz] = dispatch;
      // Limit simulation for sanity?
      const limit = dx * dy * dz;
      if (limit > 100000) {
        console.warn(`Simulating Dispatch ${dx}x${dy}x${dz} is too large. Truncating?`);
      }

      for (let z = 0; z < dz; z++) {
        for (let y = 0; y < dy; y++) {
          for (let x = 0; x < dx; x++) {
            // Set Builtins
            // GlobalInvocationID
            this.context.builtins.set('GlobalInvocationID', [x, y, z]);

            // Call Function
            this.executeFunction(funcId);
          }
        }
      }
    }
    // --- Standard Ops ---
    else {
      const handler = OpRegistry[node.op];
      if (handler) {
        handler(this.context, args);
      }
    }

    // 3. Continue Execution Flow
    this.continueFlow(node, 'exec_out', func);
  }

  private continueFlow(node: Node, portOut: string, func: FunctionDef) {
    const outEdges = func.edges.filter(e => e.from === node.id && e.portOut === portOut && e.type === 'execution');
    for (const edge of outEdges) {
      const nextNode = func.nodes.find(n => n.id === edge.to);
      if (nextNode) this.executeNode(nextNode, func);
    }
  }

  private resolveNodeValue(node: Node, func: FunctionDef, portOut: string): RuntimeValue {
    // Optimization: If NOT executable, we resolve it.
    // If IS executable, it likely doesn't have output value on "data" ports?
    // Exception: var_set outputs 'val' pass-through.

    // Resolve Inputs recursively
    const args: Record<string, RuntimeValue> = {};
    const inputEdges = func.edges.filter(e => e.to === node.id && e.type === 'data');
    for (const edge of inputEdges) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) args[edge.portIn] = this.resolveNodeValue(src, func, edge.portOut);
    }
    this.mixinNodeProperties(node, args);

    const handler = OpRegistry[node.op];
    if (handler) {
      const res = handler(this.context, args);
      if (res !== undefined) return res;
    }

    // Fallback?
    if (Object.keys(args).length === 1 && args['value'] !== undefined) return args['value'];

    return 0; // Default fallback
  }

  private mixinNodeProperties(node: Node, args: Record<string, RuntimeValue>) {
    const SKIP_RESOLUTION = ['var', 'func', 'resource', 'buffer', 'tex'];

    for (const key of Object.keys(node)) {
      if (['id', 'op', 'metadata', 'const_data'].includes(key)) continue;
      if (args[key] === undefined) {
        let val = node[key];

        // Skip identifier properties
        if (SKIP_RESOLUTION.includes(key)) {
          args[key] = val;
          continue;
        }

        // Dynamic Resolution
        if (typeof val === 'string') {
          const varVal = this.context.getVar(val);
          if (varVal !== undefined) {
            val = varVal;
          } else {
            try {
              val = this.context.getInput(val);
            } catch (e) { }
          }
        }
        args[key] = val;
      }
    }
  }
}
