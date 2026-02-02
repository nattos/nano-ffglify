import { IRDocument, FunctionDef, Node, PRIMITIVE_TYPES, PortDef, VariableDef, DataType } from './types';
import { reconstructEdges } from './utils';
import { inferFunctionTypes, InferredTypes } from './validator';

export interface IRLinePart {
  type: 'op' | 'ref' | 'literal' | 'keyword' | 'separator' | 'type' | 'comment';
  text: string;
  refId?: string; // For 'ref', what it points to
  dataType?: string;
}

export interface IRLine {
  nodeId?: string; // Primary node this line represents
  indent: number;
  parts: IRLinePart[];
}

export interface AnalyzedFunction {
  id: string;
  lines: IRLine[];
  refs: Map<string, string[]>; // symbol -> nodeIds that reference it
}

export const analyzeFunction = (func: FunctionDef, doc: IRDocument): AnalyzedFunction => {
  const lines: IRLine[] = [];
  const refs = new Map<string, string[]>();
  const edges = reconstructEdges(func);
  const inferredTypes = inferFunctionTypes(func, doc);

  // Helper to add a reference
  const addRef = (symbol: string, nodeId: string) => {
    if (!refs.has(symbol)) refs.set(symbol, []);
    refs.get(symbol)!.push(nodeId);
  };

  // 1. Function Header
  const headerParts: IRLinePart[] = [
    { type: 'keyword', text: 'fn' },
    { type: 'separator', text: ' ' },
    { type: 'ref', text: func.id, refId: func.id }
  ];

  headerParts.push({ type: 'separator', text: '(' });
  func.inputs.forEach((input, i) => {
    headerParts.push({ type: 'ref', text: input.id, refId: input.id, dataType: input.type });
    headerParts.push({ type: 'separator', text: ': ' });
    headerParts.push({ type: 'type', text: input.type });
    if (i < func.inputs.length - 1) headerParts.push({ type: 'separator', text: ', ' });
  });
  headerParts.push({ type: 'separator', text: ')' });

  if (func.outputs.length > 0) {
    headerParts.push({ type: 'separator', text: ' -> ' });
    func.outputs.forEach((output, i) => {
      headerParts.push({ type: 'type', text: output.type });
      if (i < func.outputs.length - 1) headerParts.push({ type: 'separator', text: ', ' });
    });
  }

  lines.push({ indent: 0, parts: headerParts });

  // 2. Local Variables
  func.localVars.forEach(v => {
    const varParts: IRLinePart[] = [
      { type: 'keyword', text: 'var' },
      { type: 'separator', text: ' ' },
      { type: 'ref', text: v.id, refId: v.id, dataType: v.type },
      { type: 'separator', text: ': ' },
      { type: 'type', text: v.type }
    ];
    if (v.initialValue !== undefined) {
      varParts.push({ type: 'separator', text: ' = ' });
      varParts.push({ type: 'literal', text: JSON.stringify(v.initialValue) });
    }
    lines.push({ indent: 1, parts: varParts });
  });

  if (func.localVars.length > 0) {
    // Spacer
    lines.push({ indent: 1, parts: [] });
  }

  // 3. Nodes
  let currentIndent = 1;
  const blockExits = new Map<string, number>(); // nodeID -> indent level to restore

  func.nodes.forEach(node => {
    // Check if we reached a block exit
    if (blockExits.has(node.id)) {
      currentIndent = blockExits.get(node.id)!;
      blockExits.delete(node.id);
    }

    const nodeParts = analyzeNode(node, func, doc, inferredTypes, addRef);

    // Some ops start blocks
    if (node.op === 'flow_loop') {
      lines.push({ nodeId: node.id, indent: currentIndent, parts: nodeParts });
      currentIndent++;
      if (node.exec_completed) {
        blockExits.set(node.exec_completed, currentIndent - 1);
      }
    } else if (node.op === 'flow_branch') {
      lines.push({ nodeId: node.id, indent: currentIndent, parts: nodeParts });
      // Branches are tricky because they have true/false paths.
      // For now, let's keep it simple: next node is indented.
      // We'll need better path analysis for complex branches.
      currentIndent++;
      if (node.exec_false) {
        // This is a simplification
        blockExits.set(node.exec_false, currentIndent - 1);
      }
    } else {
      lines.push({ nodeId: node.id, indent: currentIndent, parts: nodeParts });
    }
  });

  return { id: func.id, lines, refs };
};

const analyzeNode = (
  node: Node,
  func: FunctionDef,
  doc: IRDocument,
  inferredTypes: InferredTypes,
  addRef: (symbol: string, nodeId: string) => void
): IRLinePart[] => {
  const parts: IRLinePart[] = [];

  // Determine if it's an assignment
  const isExecutable = node.op.startsWith('cmd_') || node.op.startsWith('flow_') || node.op.includes('_store');
  const hasOutput = !isExecutable && node.op !== 'func_return';

  if (hasOutput) {
    parts.push({ type: 'ref', text: node.id, refId: node.id, dataType: inferredTypes.get(node.id) });
    parts.push({ type: 'separator', text: ' = ' });
  }

  parts.push({ type: 'op', text: node.op });
  parts.push({ type: 'separator', text: '(' });

  const reservedKeys = new Set(['id', 'op', 'metadata', 'comment', 'const_data', 'exec_in', 'exec_out', 'exec_true', 'exec_false', 'exec_body', 'exec_completed', 'next', '_next']);
  const args = Object.keys(node).filter(k => !reservedKeys.has(k));

  args.forEach((key, i) => {
    parts.push({ type: 'keyword', text: key });
    parts.push({ type: 'separator', text: ': ' });

    const val = node[key];
    if (typeof val === 'string') {
      // Is it a reference?
      const isRef = func.nodes.some(n => n.id === val) ||
        func.localVars.some(v => v.id === val) ||
        func.inputs.some(i => i.id === val) ||
        doc.inputs.some(i => i.id === val) ||
        doc.resources.some(r => r.id === val);

      if (isRef) {
        parts.push({ type: 'ref', text: val, refId: val });
        addRef(val, node.id);
      } else {
        parts.push({ type: 'literal', text: `"${val}"` });
      }
    } else {
      parts.push({ type: 'literal', text: JSON.stringify(val) });
    }

    if (i < args.length - 1) {
      parts.push({ type: 'separator', text: ', ' });
    }
  });

  parts.push({ type: 'separator', text: ')' });

  if (node.comment) {
    parts.push({ type: 'separator', text: '  ' });
    parts.push({ type: 'comment', text: `// ${node.comment}` });
  }

  return parts;
};
