import { IRDocument, FunctionDef, Edge, Node } from './types';
import { OpDefs, INTERNAL_KEYS } from './builtin-schemas';

/**
 * Reconstructs virtual Edge objects from Node properties.
 * This is used during the transition to a property-based flow/data representation.
 * Now driven by OpDefs schemas for robustness.
 */
export function reconstructEdges(func: FunctionDef, doc?: IRDocument): Edge[] {
  const edges: Edge[] = [];
  const nodeIds = new Set(func.nodes.map(n => n.id));
  const inputIds = new Set(func.inputs.map(i => i.id));
  const localVarIds = new Set(func.localVars.map(v => v.id));
  const globalResourceIds = new Set(doc?.resources?.map(r => r.id) || []);
  const globalInputIds = new Set(doc?.inputs?.map(i => i.id) || []);

  // Helper to verify if a string is a valid reference within this function context
  const isRefId = (id: any): id is string =>
    typeof id === 'string' && id.length > 0 &&
    (nodeIds.has(id) || inputIds.has(id) || localVarIds.has(id) || globalResourceIds.has(id) || globalInputIds.has(id));

  const isNodeId = (id: any): id is string => typeof id === 'string' && id.length > 0 && nodeIds.has(id);

  // Helper to determine if an op is executable (side-effecting)
  const isExecutableOp = (op: string) => OpDefs[op as keyof typeof OpDefs]?.isExecutable ?? false;

  for (const node of func.nodes) {
    const def = OpDefs[node.op as keyof typeof OpDefs];

    // 1. Schema-Driven Resolution
    if (def) {
      for (const [key, arg] of Object.entries(def.args)) {
        const val = node[key] ?? (node['args'] ? (node['args'] as any)[key] : undefined);
        if (val === undefined) continue;

        if (arg.refable || arg.requiredRef) {
          const refType = arg.refType || 'data';

          if (refType === 'exec') {
            if (isNodeId(val) && isExecutableOp(node.op)) {
              edges.push({ from: node.id, portOut: key, to: val, portIn: 'exec_in', type: 'execution' });
            }
          } else if (refType === 'data' || refType === 'var' || refType === 'func' || refType === 'resource') {
            const processRef = (v: any, portSuffix: string = '') => {
              if (isRefId(v)) {
                edges.push({ from: v, portOut: 'val', to: node.id, portIn: key + portSuffix, type: 'data' });
              }
            };

            if (Array.isArray(val)) {
              val.forEach((item, index) => processRef(item, `[${index}]`));
            } else {
              processRef(val);
            }
          }
        }
      }

      // Handle or consolidated containers (e.g. call_func, struct_construct)
      if ((node as any).args !== undefined || (node as any).values !== undefined) {
        const definedKeys = new Set(Object.keys(def.args));
        const traverse = (obj: any, path: string) => {
          if (obj === null || obj === undefined) return;
          if (typeof obj === 'string') {
            if (isRefId(obj)) {
              edges.push({ from: obj, portOut: 'val', to: node.id, portIn: path, type: 'data' });
            }
          } else if (Array.isArray(obj)) {
            obj.forEach((item, i) => traverse(item, `${path}[${i}]`));
          } else if (typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
              if (path === '' && (INTERNAL_KEYS.has(k) || k.startsWith('exec_') || k === 'next' || k === '_next')) continue;
              // If we are at root, and it's a defined non-refable key, we still might want to traverse IF it's args or values
              if (path === '' && definedKeys.has(k) && k !== 'args' && k !== 'values') continue;

              traverse(v, path === '' ? k : `${path}.${k}`);
            }
          }
        };

        traverse(node, '');
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
