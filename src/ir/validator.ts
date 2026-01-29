import { IRDocument, Node, FunctionDef } from './types';
import { OpSignatures } from './signatures';

export interface ValidationError {
  nodeId?: string;
  message: string;
  severity: 'error' | 'warning';
}

export const validateIR = (doc: IRDocument): ValidationError[] => {
  const errors: ValidationError[] = [];

  // Pass 1: Global Validation
  // Check Resources
  const resourceIds = new Set(doc.resources.map(r => r.id));
  doc.resources.forEach(r => {
    // Basic checks if needed
  });

  // Pass 2: Function Validation
  doc.functions.forEach(func => {
    validateFunction(func, resourceIds, errors);
  });

  return errors;
};

const validateFunction = (func: FunctionDef, resourceIds: Set<string>, errors: ValidationError[]) => {
  const nodeIds = new Set(func.nodes.map(n => n.id));

  // Check Edges
  func.edges.forEach(edge => {
    if (!nodeIds.has(edge.from)) {
      errors.push({ message: `Edge source node '${edge.from}' not found`, severity: 'error' });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ message: `Edge target node '${edge.to}' not found`, severity: 'error' });
    }
  });

  checkEdgeTypes(func, errors);

  // Check Nodes
  func.nodes.forEach(node => {
    validateNode(node, func, resourceIds, errors);
  });
};

const checkEdgeTypes = (func: FunctionDef, errors: ValidationError[]) => {
  func.edges.filter(e => e.type === 'data').forEach(edge => {
    const srcNode = func.nodes.find(n => n.id === edge.from);
    const tgtNode = func.nodes.find(n => n.id === edge.to);

    if (!srcNode || !tgtNode) return; // Already caught by exist check

    const srcSig = OpSignatures[srcNode.op as keyof typeof OpSignatures];
    const tgtSig = OpSignatures[tgtNode.op as keyof typeof OpSignatures];

    if (!srcSig || !tgtSig) return; // Skip if unknown ops

    const outType = srcSig.outputs;
    const inDef = tgtSig.inputs[edge.portIn];

    if (!inDef) {
      errors.push({ nodeId: tgtNode.id, message: `Op '${tgtNode.op}' does not have input port '${edge.portIn}'`, severity: 'error' });
      return;
    }

    const inType = inDef.type;

    // Type Compatibility Check
    // 'any' matches anything.
    // Exact match required otherwise?
    // 'vector' matches 'vector'.
    // 'number' matches 'number'.

    if (outType && outType !== 'any' && inType !== 'any' && outType !== inType) {
      errors.push({
        nodeId: tgtNode.id,
        message: `Type Mismatch: '${srcNode.id}'.${edge.portOut} (${outType}) -> '${tgtNode.id}'.${edge.portIn} (${inType})`,
        severity: 'error'
      });
    }
  });
};

const validateNode = (node: Node, func: FunctionDef, resourceIds: Set<string>, errors: ValidationError[]) => {
  const sig = OpSignatures[node.op as keyof typeof OpSignatures];

  // 1. Unknown Op check (if we had a full registry list, we could verify existence)
  // For now, only validate signature if it exists.

  if (sig) {
    // Validate Inputs
    for (const [argName, argDef] of Object.entries(sig.inputs)) {
      const isProvided = node[argName] !== undefined ||
        func.edges.some(e => e.to === node.id && e.portIn === argName);

      if (!isProvided && (argDef.required !== false)) {
        errors.push({ nodeId: node.id, message: `Missing required argument '${argName}' for op '${node.op}'`, severity: 'error' });
        continue;
      }

      // Type check for literals
      if (node[argName] !== undefined) {
        const val = node[argName];
        const type = typeof val;

        // Special checks
        if (argDef.type === 'string' && type !== 'string') {
          errors.push({ nodeId: node.id, message: `Argument '${argName}' must be a string (got ${type})`, severity: 'error' });
        }
        if (argDef.type === 'number' && type !== 'number') {
          errors.push({ nodeId: node.id, message: `Argument '${argName}' must be a number (got ${type})`, severity: 'error' });
        }

        // Vector checks?
        if (argDef.type === 'vector' && !Array.isArray(val) && type !== 'string') { // string could be node ID?
          // If val is string, it might be a node ID ref (valid runtime), OR a literal string (invalid).
          // The IR structure makes this ambiguous: `a: "node_id"` vs `a: "literal_string"`.
          // Standard: If `a` is a string and matches another node ID, it's a ref.
          // If it doesn't match a node ID, is it a string literal?
          // 'vec' ops don't take string literals.
          // So if it's a string, it MUST be a ref.
          // If it's a number[], it's a literal vector.
          if (typeof val === 'object' && !Array.isArray(val)) {
            errors.push({ nodeId: node.id, message: `Argument '${argName}' expected vector, got object`, severity: 'error' });
          }
        }
      }
    }
  }

  // Resource Checks
  if (node.op.startsWith('buffer_') || node.op.startsWith('texture_')) {
    // usually 'buffer' or 'tex' prop
    const resId = node['buffer'] || node['tex'] || node['resource'];
    if (typeof resId === 'string' && !resourceIds.has(resId)) {
      errors.push({ nodeId: node.id, message: `Referenced resource '${resId}' not found`, severity: 'error' });
    }
  }
};
