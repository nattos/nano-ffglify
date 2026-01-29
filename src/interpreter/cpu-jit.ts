import { FunctionDef, Node, Edge } from '../ir/types';

/**
 * CPU JIT Compiler
 * Compiles IR Functions into "ASM.js-like" flat JavaScript for high-performance execution.
 */
export class CpuJitCompiler {

  compile(func: FunctionDef): Function {
    const lines: string[] = [];

    lines.push(`"use strict";`);
    lines.push(`// Compiled Function: ${func.id}`);

    // 1. Local Variables
    // Declared at top level of function scope
    const locVars = func.localVars.map(v => `let l_${v.id} = ${JSON.stringify(v.initialValue ?? 0)};`);
    if (locVars.length) {
      lines.push(`// Locals`);
      lines.push(...locVars);
    }



    // 2. Result Variables for Executable Nodes that return data (e.g. call_func)
    // We declare them at top level to ensure scope visibility.
    const resultVars = func.nodes
      .filter(n => n.op === 'call_func' || n.op === 'array_set')
      .map(n => `let r_${n.id};`);

    if (resultVars.length) {
      lines.push(`// Node Results`);
      lines.push(...resultVars);
    }

    // 3. Find Entry Nodes
    const entryNodes = func.nodes.filter(n => {
      const hasExecIn = func.edges.some(e => e.to === n.id && e.type === 'execution');
      return !hasExecIn && this.isExecutable(n.op);
    });

    // 4. Emit Body
    for (const entry of entryNodes) {
      this.emitChain(entry, func, lines, new Set());
    }


    const body = lines.join('\n');
    // console.log("--- JIT CODE ---\n", body);
    try {
      return new Function('ctx', 'resources', 'globals', body);
    } catch (e) {
      console.error("JIT Compilation Failed:\n", body);
      throw e;
    }
  }

  private isExecutable(op: string) {
    return op.startsWith('cmd_') || op.startsWith('flow_') || op.startsWith('var_') ||
      op.startsWith('buffer_') || op.startsWith('texture_') || op === 'call_func' || op === 'func_return' || op === 'array_set';
  }

  private emitChain(startNode: Node, func: FunctionDef, lines: string[], visited: Set<string>) {
    let curr: Node | undefined = startNode;

    while (curr) {
      if (visited.has(curr.id) && curr.op !== 'flow_loop') { // Allow loops to be re-visited if we were doing true CFG logic, but for simple emission we stop.
        // HOWEVER, loops handle their own body. Re-visiting usually implies cycle or merge.
        // For JIT of structured graph, merge points are tricky.
        // But our IR uses `exec_out` -> ...
        // If two branches merge, they point to same node.
        // We need to detect if node has multiple incoming.
        // MVP: Don't handle complex merges (diamond problem) optimally (code duplication) unless structured.
        lines.push(`// Re-visiting ${curr.id} (possible merge point execution)`);
        // Break if visited? Or duplicate code?
        // Duplicate is safer for now.
      }
      visited.add(curr.id);

      if (curr.op === 'flow_branch') {
        this.emitBranch(curr, func, lines, visited);
        return; // Execution continues in branches
      } else if (curr.op === 'flow_loop') {
        this.emitLoop(curr, func, lines, visited);
        // Loop handles continuation via 'exec_completed'
        // But emitLoop should call emitChain for 'exec_completed'
        return;
      } else if (curr.op === 'func_return') {
        lines.push(`return ${this.resolveArg(curr, 'val', func)};`);
        return;
      } else {
        this.emitNode(curr, func, lines);
      }

      // Next Node
      curr = this.getNextNode(curr, 'exec_out', func);
    }
  }

  private emitBranch(node: Node, func: FunctionDef, lines: string[], visited: Set<string>) {
    const cond = this.resolveArg(node, 'cond', func);
    lines.push(`if (${cond}) {`);
    const trueNode = this.getNextNode(node, 'exec_true', func);
    if (trueNode) this.emitChain(trueNode, func, lines, new Set(visited));
    lines.push(`} else {`);
    const falseNode = this.getNextNode(node, 'exec_false', func);
    if (falseNode) this.emitChain(falseNode, func, lines, new Set(visited));
    lines.push(`}`);
  }

  private emitLoop(node: Node, func: FunctionDef, lines: string[], visited: Set<string>) {
    const start = this.resolveArg(node, 'start', func);
    const end = this.resolveArg(node, 'end', func);
    // Loop variable isn't explicitly declared in IR Node usually?
    // Interpreter sets `LOOP_INDEX` in context.
    // We should use a temp JS var.
    const loopVar = `loop_${node.id}`;
    lines.push(`for (let ${loopVar} = ${start}; ${loopVar} < ${end}; ${loopVar}++) {`);
    // Expose loop variable to body?
    // `loop_index` op reads it. We need a way to map `loop_index` op to this var.
    // We can use a map `nodeId -> expression`.
    // But `loop_index` takes `loop` ID as arg.
    // Implementation of `loop_index`: return `loop_${loopId}`.

    const bodyNode = this.getNextNode(node, 'exec_body', func);
    if (bodyNode) this.emitChain(bodyNode, func, lines, new Set(visited));
    lines.push(`}`);

    // Continuation
    const nextNode = this.getNextNode(node, 'exec_completed', func);
    if (nextNode) this.emitChain(nextNode, func, lines, visited);
  }

  private emitNode(node: Node, func: FunctionDef, lines: string[]) {
    // Op Handling
    if (node.op === 'cmd_dispatch') {
      const targetId = node['func'];
      // Dispatch args
      // 'dispatch' prop might be an array literal or reference?
      // Node prop is usually literal array in IR for now.
      // If it's dynamic, we need `resolveArg`.
      // Let's assume literal for MVP or resolve it.
      // If `dispatch` is input, resolveArg handles it but it returns a string expression.
      // We probably need to resolve x, y, z separately if they are dynamic.
      // Current IR `cmd_dispatch` has `dispatch: [x, y, z]`.
      // If they are numbers, easy.

      // MVP: Assume literal array or default [1,1,1]
      let dimCode = '[1, 1, 1]';
      if (Array.isArray(node['dispatch'])) {
        dimCode = JSON.stringify(node['dispatch']);
      }

      lines.push(`globals.dispatch('${targetId}', ${dimCode});`);
    }
    else if (node.op === 'cmd_resize_resource') {
      const resId = node['resource'];
      const size = this.resolveArg(node, 'size', func);

      const resolveRaw = (key: string) => {
        const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
        if (edge || node[key] !== undefined) return this.resolveArg(node, key, func);
        return 'undefined';
      };
      const format = resolveRaw('format');
      const clear = resolveRaw('clear'); // TODO: Check if 'clear' implies vector or scalar

      lines.push(`globals.resize('${resId}', ${size}, ${format}, ${clear});`);
    }
    else if (node.op === 'call_func') {
      const targetId = node['func'];
      lines.push(`r_${node.id} = globals.callFunc('${targetId}', ${this.generateArgsObject(node, func)});`);
    }
    else if (node.op === 'array_set') {
      lines.push(`r_${node.id} = globals.callOp('array_set', ${this.generateArgsObject(node, func)});`);
    }
    else if (node.op === 'texture_store') {
      lines.push(`globals.callOp('texture_store', ${this.generateArgsObject(node, func)});`);
    }
    else if (node.op === 'func_return') {
      const val = this.resolveArg(node, 'value', func);
      lines.push(`return ${val};`);
    }

    else if (node.op === 'var_set') {
      const val = this.resolveArg(node, 'val', func);
      const varId = node['var']; // String ID
      lines.push(`l_${varId} = ${val};`);
      lines.push(`ctx.setVar('${varId}', l_${varId});`);
    }
    else if (node.op === 'var_get') {
      // usually purely data node, handled by resolution.
      // But if it is in execution chain? No, it's data.
      // Only executable nodes are in chain.
    }
    else if (node.op === 'buffer_store') {
      const bufferId = node['buffer']; // We need mechanism to access buffer by ID.
      // `resources[bufferId]`?
      // We pass `resources` map to compiled function.
      // `ctx.getResource(id)`
      // Optimization: `resources['${bufferId}'].data[index] = val;`
      const idx = this.resolveArg(node, 'index', func);
      const val = this.resolveArg(node, 'value', func);
      // Assuming ctx is passed. Using ctx for resources is slower than direct map.
      // But `resources` arg can be a pre-built map of TypedArrays.
      lines.push(`ctx.getResource('${bufferId}').data[${idx}] = ${val};`);
    }
    else if (node.op === 'math_add') {
      // Calculation node.
      // In Interpreter, `math_add` IS executable?
      // WAIT. In our IR, `math_add` is usually PURE DATA.
      // It is NOT in the execution chain execution edges.
      // It is pulled by `var_set` or `buffer_store`.
      // So `emitNode` is strictly for side-effect nodes (store, set, call).
      // Calculation is handled in `resolveArg` recursively!
      // EXCEPT if we want to JIT calculations into temp variables to avoid re-calc.
      // For MVP, inline calculations.
    }
    else {
      lines.push(`// Unknown Executable Op: ${node.op}`);
    }
  }

  private getNextNode(node: Node, port: string, func: FunctionDef): Node | undefined {
    const edge = func.edges.find(e => e.from === node.id && e.portOut === port && e.type === 'execution');
    if (!edge) return undefined;
    return func.nodes.find(n => n.id === edge.to);
  }

  private resolveArg(node: Node, key: string, func: FunctionDef): string {
    // 1. Incoming Edges (Highest Priority)
    const edge = func.edges.find(e => e.to === node.id && e.portIn === key && e.type === 'data');
    if (edge) {
      const source = func.nodes.find(n => n.id === edge.from);
      if (source) return this.compileExpression(source, func);
    }

    // 2. Literal Properties
    if (node[key] !== undefined) {
      const val = node[key];
      if (typeof val === 'string' && key !== 'var' && key !== 'func') {
        // Local Variable?
        if (func.localVars.some(v => v.id === val)) {
          return `l_${val}`;
        }
        // Input?
        // We generally assume strings not matching locals are Inputs.
        // But some ops take string literals (e.g. swizzle channels).
        // The Interpreter tries to resolve input, suppresses error if missing, and uses literal.
        return `globals.resolveString('${val}')`;
      }
      return JSON.stringify(val);
    }

    return '0'; // Default
  }

  private isEdgeConnection(node: Node, key: string) {
    // Check if there's an incoming edge overriding this prop
    // Actually resolveArg logic covers this Priority (Edge > Prop?).
    // Interpreter: Prop if undefined, else Edge? No.
    // Interpreter: Prop is used if Edge NOT present.
    // My logic above handles it correctly (Check Prop, but wait... Edge should override Prop?)
    // Actually `mixinNodeProperties` says: "If args[key] is undefined" (initially empty).
    // It populates from Props.
    // Then overwrites from Edges.
    // So Edge > Prop.
    return false; // Helper not really needed if we change order.
  }

  private compileExpression(node: Node, func: FunctionDef): string {
    // Recursive expression compilation

    if (node.op === 'var_get') {
      const varId = node['var'];
      if (func.localVars.some(v => v.id === varId)) {
        return `l_${varId}`;
      }
      return `globals.resolveVar('${varId}')`;
    }
    if (node.op === 'literal') {
      return `${node['val']}`;
    }
    if (node.op === 'loop_index') {
      const loopId = node['loop'];
      return `loop_${loopId}`;
    }

    if (node.op === 'buffer_load') {
      const bufferId = node['buffer'];
      return `globals.bufferLoad('${bufferId}', ${this.resolveArg(node, 'index', func)})`;
    }
    if (node.op === 'call_func' || node.op === 'array_set') {
      return `r_${node.id}`;
    }

    if (node.op.startsWith('texture_') || node.op.startsWith('resource_')) {
      return `globals.callOp('${node.op}', ${this.generateArgsObject(node, func)})`;
    }
    if (node.op === 'array_set') {
      return `r_${node.id}`;
    }

    // Generic Op Handling via Registry
    return `globals.callOp('${node.op}', ${this.generateArgsObject(node, func)})`;
  }

  private generateArgsObject(node: Node, func: FunctionDef): string {
    const parts: string[] = [];

    // 1. Edges targeting this node
    const inputs = func.edges.filter(e => e.to === node.id && e.type === 'data');
    const inputKeys = new Set(inputs.map(e => e.portIn));

    for (const edge of inputs) {
      const src = func.nodes.find(n => n.id === edge.from);
      if (src) {
        parts.push(`${edge.portIn}: ${this.compileExpression(src, func)}`);
      }
    }

    // 2. Literal Props (if not in edges)
    for (const key of Object.keys(node)) {
      if (['id', 'op', 'metadata', 'const_data'].includes(key)) continue;
      if (inputKeys.has(key)) continue; // Edge overrides prop

      // resolveArg logic handles resolving literals, but compileExpression/resolveArg handles specific keys.
      // Here we just want the value.
      // If it's a string looking like local var?
      // reused `resolveArg` logic?
      // Yes: `resolveArg` handles all this.
      // So we just iterate keys?
      // But `resolveArg` needs a `key`.
      parts.push(`${key}: ${this.resolveArg(node, key, func)}`);
    }

    return `{ ${parts.join(', ')} }`;
  }
}
