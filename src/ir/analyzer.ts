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
  // Scoping helpers
  const getLocalRefId = (id: string) => `${func.id}:${id}`;
  const getGlobalRefId = (id: string) => `global:${id}`;

  // 1. Function Comment (top-level)
  if (func.comment) {
    lines.push({ indent: 0, parts: [{ type: 'comment', text: `// ${func.comment}` }] });
  }

  // 2. Function Header
  const headerParts: IRLinePart[] = [
    { type: 'keyword', text: 'fn' },
    { type: 'separator', text: ' ' },
    { type: 'ref', text: func.id, refId: getGlobalRefId(func.id) }
  ];

  headerParts.push({ type: 'separator', text: '(' });
  func.inputs.forEach((input, i) => {
    headerParts.push({ type: 'ref', text: input.id, refId: getLocalRefId(input.id), dataType: input.type });
    headerParts.push({ type: 'separator', text: ': ' });
    headerParts.push({ type: 'type', text: input.type });

    if (input.comment) {
      headerParts.push({ type: 'separator', text: ' ' });
      headerParts.push({ type: 'comment', text: `/* ${input.comment} */` });
    }

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
      { type: 'ref', text: v.id, refId: getLocalRefId(v.id), dataType: v.type },
      { type: 'separator', text: ': ' },
      { type: 'type', text: v.type }
    ];
    if (v.initialValue !== undefined) {
      varParts.push({ type: 'separator', text: ' = ' });
      varParts.push({ type: 'literal', text: JSON.stringify(v.initialValue) });
    }
    if (v.comment) {
      varParts.push({ type: 'separator', text: '  ' });
      varParts.push({ type: 'comment', text: `// ${v.comment}` });
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
      currentIndent++;
      if (node.exec_false) {
        blockExits.set(node.exec_false, currentIndent - 1);
      }
    } else {
      lines.push({ nodeId: node.id, indent: currentIndent, parts: nodeParts });
    }
  });

  return { id: func.id, lines, refs };
};

export const analyzeGlobals = (doc: IRDocument): IRLine[] => {
  const lines: IRLine[] = [];
  const getGlobalRefId = (id: string) => `global:${id}`;

  // 1. Global Inputs
  doc.inputs.forEach(input => {
    const parts: IRLinePart[] = [
      { type: 'keyword', text: 'var' },
      { type: 'separator', text: ' ' },
      { type: 'ref', text: input.id, refId: getGlobalRefId(input.id), dataType: input.type },
      { type: 'separator', text: ': ' },
      { type: 'type', text: input.type }
    ];
    if (input.default !== undefined) {
      parts.push({ type: 'separator', text: ' = ' });
      parts.push({ type: 'literal', text: JSON.stringify(input.default) });
    }
    if (input.comment) {
      parts.push({ type: 'separator', text: '  ' });
      parts.push({ type: 'comment', text: `// ${input.comment}` });
    }
    lines.push({ indent: 0, parts });
  });

  // 2. Resources (Buffers/Textures)
  doc.resources.forEach(res => {
    const parts: IRLinePart[] = [
      { type: 'keyword', text: 'res' },
      { type: 'separator', text: ' ' },
      { type: 'ref', text: res.id, refId: getGlobalRefId(res.id), dataType: res.type },
      { type: 'separator', text: ': ' },
      { type: 'type', text: res.type }
    ];

    // Add some metadata if available
    const meta: string[] = [];
    if (res.format) meta.push(`format: ${res.format}`);
    if (res.size) {
      if (res.size.mode === 'fixed') meta.push(`size: [${res.size.value}]`);
      else if (res.size.mode === 'reference') meta.push(`size: ref(${res.size.ref})`);
    }

    if (meta.length > 0 || res.comment) {
      parts.push({ type: 'separator', text: '  ' });
      let comment = '';
      if (meta.length > 0) comment += `[${meta.join(', ')}] `;
      if (res.comment) comment += res.comment;
      parts.push({ type: 'comment', text: `// ${comment.trim()}` });
    }

    lines.push({ indent: 0, parts });
  });

  if (lines.length > 0) {
    lines.push({ indent: 0, parts: [] }); // Spacer
  }

  return lines;
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

  const getLocalRefId = (id: string) => `${func.id}:${id}`;
  const getGlobalRefId = (id: string) => `global:${id}`;

  if (hasOutput) {
    const refId = getLocalRefId(node.id);
    const type = inferredTypes.get(node.id);
    parts.push({ type: 'ref', text: node.id, refId: refId, dataType: type });
    if (type) {
      parts.push({ type: 'separator', text: ': ' });
      parts.push({ type: 'type', text: type });
    }
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
      const isLocal = func.nodes.some(n => n.id === val) ||
        func.localVars.some(v => v.id === val) ||
        func.inputs.some(i => i.id === val);

      const isGlobal = doc.inputs.some(i => i.id === val) ||
        doc.resources.some(r => r.id === val) ||
        doc.functions.some(f => f.id === val);

      if (isLocal) {
        const refId = getLocalRefId(val);
        parts.push({ type: 'ref', text: val, refId: refId });
        addRef(refId, node.id);
      } else if (isGlobal) {
        const refId = getGlobalRefId(val);
        parts.push({ type: 'ref', text: val, refId: refId });
        addRef(refId, node.id);
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
