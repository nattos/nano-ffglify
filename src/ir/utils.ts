import { FunctionDef, Edge, Node } from './types';
import { OpDefs } from './builtin-schemas';

/**
 * Reconstructs virtual Edge objects from Node properties.
 * This is used during the transition to a property-based flow/data representation.
 * Now driven by OpDefs schemas for robustness.
 */
export function reconstructEdges(func: FunctionDef): Edge[] {
  const edges: Edge[] = [];
  const nodeIds = new Set(func.nodes.map(n => n.id));

  // Helper to verify if a string is a valid node reference within this function
  const isNodeId = (id: any): id is string => typeof id === 'string' && id.length > 0 && nodeIds.has(id);

  // Helper to determine if an op is executable (side-effecting)
  // consistent with InterpretedExecutor and wgsl-generator
  const isExecutableOp = (op: string) =>
    op.startsWith('cmd_') ||
    op.startsWith('flow_') ||
    op.startsWith('var_set') ||
    op.startsWith('array_set') ||
    op.startsWith('buffer_store') ||
    op.startsWith('texture_store') ||
    op === 'call_func' ||
    op === 'func_return';

  // Standard metadata/internal keys to ignore if not in schema
  const INTERNAL_KEYS = new Set(['id', 'op', 'metadata', 'comment', 'const_data', 'dataType']);

  for (const node of func.nodes) {
    const def = OpDefs[node.op as keyof typeof OpDefs];

    // 1. Schema-Driven Resolution
    if (def) {
      for (const [key, arg] of Object.entries(def.args)) {
        const val = node[key];
        if (val === undefined) continue;

        if (arg.refable || arg.requiredRef) {
          const refType = arg.refType || 'data';

          if (refType === 'exec') {
            if (isNodeId(val) && isExecutableOp(node.op)) {
              edges.push({ from: node.id, portOut: key, to: val, portIn: 'exec_in', type: 'execution' });
            }
          } else if (refType === 'data' || refType === 'var' || refType === 'func' || refType === 'resource') {
            if (arg.isArray && Array.isArray(val)) {
              val.forEach((item, index) => {
                if (isNodeId(item)) {
                  edges.push({ from: item, portOut: 'val', to: node.id, portIn: `${key}[${index}]`, type: 'data' });
                }
              });
            } else if (isNodeId(val)) {
              edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
            }
          }
        }
      }

      // Handle Dynamic Nodes (e.g. call_func, struct_construct)
      if (def.isDynamic) {
        for (const [key, val] of Object.entries(node)) {
          if (def.args[key]) continue; // Already handled
          if (INTERNAL_KEYS.has(key)) continue;
          if (key.startsWith('exec_') || key === 'next' || key === '_next') continue;

          if (isNodeId(val)) {
            edges.push({ from: val, portOut: 'val', to: node.id, portIn: key, type: 'data' });
          }
        }
      }
    }

    // 2. Implicit Execution Flow Heuristics (Fallbacks)
    // Incoming flow: Only apply if no other execution flow points to this node yet.
    if (isNodeId(node.exec_in)) {
      const srcNode = func.nodes.find(n => n.id === node.exec_in);
      const isSrcExecutable = srcNode ? isExecutableOp(srcNode.op) : false;

      if (isSrcExecutable) {
        const explicitFlow = edges.find(e => e.to === node.id && e.portIn === 'exec_in' && e.type === 'execution');
        if (!explicitFlow) {
          edges.push({ from: node.exec_in, portOut: 'exec_out', to: node.id, portIn: 'exec_in', type: 'execution' });
        }
      }
    }

    // Outgoing flow: Default 'next' or 'exec_out' property to 'exec_in' port
    // Only if THIS node is executable
    if (isExecutableOp(node.op)) {
      const nextId = node.next || node._next || node.exec_out;
      if (isNodeId(nextId)) {
        edges.push({ from: node.id, portOut: 'exec_out', to: nextId, portIn: 'exec_in', type: 'execution' });
      }
    }
  }

  // Deduplicate edges
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.from}:${e.portOut}:${e.to}:${e.portIn}:${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
