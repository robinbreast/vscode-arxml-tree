import * as vscode from 'vscode';
import * as fs from 'fs';
import { parser as saxParser, QualifiedTag } from 'sax';
import { ArxmlNode } from './arxmlNode';

const SHORT_NAME_TAG = 'SHORT-NAME';
const INVALID_XML_CHARS = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g;
const CHUNK_SIZE = 64_000;

interface ElementFrame {
  tag: string;
  startOffset: number;
  uuid?: string;
  node?: ArxmlNode;
  shortName?: string;
  containerParent?: ArxmlNode;
  containerChildrenStart?: number;
}

interface ParseOptions {
  strict?: boolean;
  nameTags?: string[];
  nameTextTags?: string[];
  includeUnnamedContainers?: boolean;
  abortSignal?: AbortSignal;
}

export async function parseArxmlDocument(
  text: string,
  uri: vscode.Uri,
  positionAt: (offset: number) => vscode.Position,
  options: ParseOptions = {}
): Promise<ArxmlNode | undefined> {
  if (!text || !text.trim()) {
    return undefined;
  }

  const rootNode: ArxmlNode = {
    name: '/',
    arpath: '',
    element: 'AUTOSAR',
    file: uri,
    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
    parent: undefined,
    children: []
  };

  const parseText = sanitizeXmlText(text);
  const parser = saxParser(options.strict ?? true, { trim: false, normalize: false, position: true });
  const elementStack: ElementFrame[] = [];
  const arNodeStack: ArxmlNode[] = [rootNode];
  let parseError: Error | undefined;
  const nameTags = new Set(options.nameTags ?? [SHORT_NAME_TAG]);
  const nameTextTags = new Set(options.nameTextTags ?? []);

  parser.onerror = (err) => {
    parseError = err;
    parser.resume();
  };

  parser.onopentag = (node: QualifiedTag) => {
    const start = parser.startTagPosition ? parser.startTagPosition - 1 : Math.max(0, parser.position - node.name.length - 2);
    const frame: ElementFrame = {
      tag: node.name,
      startOffset: start,
      uuid: typeof node.attributes.UUID === 'string' ? node.attributes.UUID : undefined
    };
    if (options.includeUnnamedContainers && !nameTags.has(node.name) && !nameTextTags.has(node.name)) {
      const containerParent = arNodeStack[arNodeStack.length - 1];
      frame.containerParent = containerParent;
      frame.containerChildrenStart = containerParent.children.length;
    }
    elementStack.push(frame);
  };

  parser.ontext = (value: string) => {
    const frame = elementStack[elementStack.length - 1];
    if (!frame) {
      return;
    }

    if (nameTags.has(frame.tag)) {
      frame.shortName = (frame.shortName ?? '') + value;
      return;
    }

    if (nameTextTags.size > 0 && nameTextTags.has(frame.tag)) {
      const parentFrame = elementStack[elementStack.length - 2];
      if (parentFrame && nameTags.has(parentFrame.tag)) {
        parentFrame.shortName = (parentFrame.shortName ?? '') + value;
      }
    }
  };

  parser.onclosetag = () => {
    const frame = elementStack.pop();
    if (!frame) {
      return;
    }

    if (nameTags.has(frame.tag)) {
      const parentFrame = elementStack[elementStack.length - 1];
      if (parentFrame) {
        parentFrame.shortName = frame.shortName?.trim() ?? '';
        createNodeForFrame(parentFrame);
      }
      return;
    }

    if (frame.node) {
      const end = clampOffset(parseText, parser.position);
      frame.node.range = new vscode.Range(frame.node.range.start, positionAt(end));
      if (arNodeStack[arNodeStack.length - 1] === frame.node) {
        arNodeStack.pop();
      }
    }

    const parentNode = frame.containerParent;
    const childrenStart = frame.containerChildrenStart;
    if (!options.includeUnnamedContainers || frame.node || !parentNode || childrenStart === undefined || frame.tag === rootNode.element) {
      return;
    }

    if (parentNode.children.length <= childrenStart) {
      return;
    }

    const start = clampOffset(parseText, frame.startOffset);
    const end = clampOffset(parseText, parser.position);
    const containerChildren = parentNode.children.splice(childrenStart);
    const containerNode: ArxmlNode = {
      name: frame.tag,
      arpath: `${parentNode.arpath}/@${frame.tag}:${start}`,
      element: frame.tag,
      file: uri,
      range: new vscode.Range(positionAt(start), positionAt(end)),
      uuid: frame.uuid,
      parent: parentNode,
      children: containerChildren
    };
    for (const child of containerChildren) {
      child.parent = containerNode;
    }
    parentNode.children.splice(childrenStart, 0, containerNode);
  };

  await streamParse(parser, parseText, options.abortSignal);

  if (parseError) {
    throw parseError;
  }

  rootNode.range = new vscode.Range(new vscode.Position(0, 0), positionAt(parseText.length));
  return rootNode;

  function createNodeForFrame(frame: ElementFrame) {
    if (frame.node || !frame.shortName) {
      return;
    }

    const trimmed = frame.shortName.trim();
    if (!trimmed) {
      return;
    }

    const parentNode = arNodeStack[arNodeStack.length - 1];
    const start = clampOffset(parseText, frame.startOffset);
    const node: ArxmlNode = {
      name: trimmed,
      arpath: `${parentNode.arpath}/${trimmed}`,
      element: frame.tag,
      file: uri,
      range: new vscode.Range(positionAt(start), positionAt(start)),
      uuid: frame.uuid,
      parent: parentNode,
      children: []
    };

    parentNode.children.push(node);
    frame.node = node;
    arNodeStack.push(node);
  }
}

export async function parseArxmlDocumentFromFile(
  uri: vscode.Uri,
  options: ParseOptions = {}
): Promise<ArxmlNode | undefined> {
  const rootNode: ArxmlNode = {
    name: '/',
    arpath: '',
    element: 'AUTOSAR',
    file: uri,
    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
    parent: undefined,
    children: []
  };

  const parser = saxParser(options.strict ?? true, { trim: false, normalize: false, position: true });
  const elementStack: ElementFrame[] = [];
  const arNodeStack: ArxmlNode[] = [rootNode];
  let parseError: Error | undefined;
  let totalLength = 0;
  let hasNonWhitespace = false;
  const lineOffsets: number[] = [0];
  const nameTags = new Set(options.nameTags ?? [SHORT_NAME_TAG]);
  const nameTextTags = new Set(options.nameTextTags ?? []);

  const positionAt = (offset: number): vscode.Position => {
    const clamped = clampOffsetByLength(totalLength, offset);
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const lineStart = lineOffsets[mid];
      const nextLineStart = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : totalLength + 1;
      if (clamped >= lineStart && clamped < nextLineStart) {
        return new vscode.Position(mid, clamped - lineStart);
      }
      if (clamped < lineStart) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return new vscode.Position(0, clamped);
  };

  parser.onerror = (err) => {
    parseError = err;
    parser.resume();
  };

  parser.onopentag = (node: QualifiedTag) => {
    const start = parser.startTagPosition ? parser.startTagPosition - 1 : Math.max(0, parser.position - node.name.length - 2);
    const frame: ElementFrame = {
      tag: node.name,
      startOffset: start,
      uuid: typeof node.attributes.UUID === 'string' ? node.attributes.UUID : undefined
    };
    if (options.includeUnnamedContainers && !nameTags.has(node.name) && !nameTextTags.has(node.name)) {
      const containerParent = arNodeStack[arNodeStack.length - 1];
      frame.containerParent = containerParent;
      frame.containerChildrenStart = containerParent.children.length;
    }
    elementStack.push(frame);
  };

  parser.ontext = (value: string) => {
    const frame = elementStack[elementStack.length - 1];
    if (!frame) {
      return;
    }

    if (nameTags.has(frame.tag)) {
      frame.shortName = (frame.shortName ?? '') + value;
      return;
    }

    if (nameTextTags.size > 0 && nameTextTags.has(frame.tag)) {
      const parentFrame = elementStack[elementStack.length - 2];
      if (parentFrame && nameTags.has(parentFrame.tag)) {
        parentFrame.shortName = (parentFrame.shortName ?? '') + value;
      }
    }
  };

  parser.onclosetag = () => {
    const frame = elementStack.pop();
    if (!frame) {
      return;
    }

    if (nameTags.has(frame.tag)) {
      const parentFrame = elementStack[elementStack.length - 1];
      if (parentFrame) {
        parentFrame.shortName = frame.shortName?.trim() ?? '';
        createNodeForFrame(parentFrame);
      }
      return;
    }

    if (frame.node) {
      const end = clampOffsetByLength(totalLength, parser.position);
      frame.node.range = new vscode.Range(frame.node.range.start, positionAt(end));
      if (arNodeStack[arNodeStack.length - 1] === frame.node) {
        arNodeStack.pop();
      }
    }

    const parentNode = frame.containerParent;
    const childrenStart = frame.containerChildrenStart;
    if (!options.includeUnnamedContainers || frame.node || !parentNode || childrenStart === undefined || frame.tag === rootNode.element) {
      return;
    }

    if (parentNode.children.length <= childrenStart) {
      return;
    }

    const start = clampOffsetByLength(totalLength, frame.startOffset);
    const end = clampOffsetByLength(totalLength, parser.position);
    const containerChildren = parentNode.children.splice(childrenStart);
    const containerNode: ArxmlNode = {
      name: frame.tag,
      arpath: `${parentNode.arpath}/@${frame.tag}:${start}`,
      element: frame.tag,
      file: uri,
      range: new vscode.Range(positionAt(start), positionAt(end)),
      uuid: frame.uuid,
      parent: parentNode,
      children: containerChildren
    };
    for (const child of containerChildren) {
      child.parent = containerNode;
    }
    parentNode.children.splice(childrenStart, 0, containerNode);
  };

  const stream = fs.createReadStream(uri.fsPath, { encoding: 'utf8', highWaterMark: CHUNK_SIZE });
  try {
    for await (const rawChunk of stream) {
      if (options.abortSignal?.aborted) {
        throw new Error('Parsing cancelled');
      }

      const chunk = sanitizeXmlText(rawChunk);
      if (!hasNonWhitespace && /\S/.test(chunk)) {
        hasNonWhitespace = true;
      }

      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '\n') {
          lineOffsets.push(totalLength + i + 1);
        }
      }
      totalLength += chunk.length;

      parser.write(chunk);
    }
    parser.close();
  } finally {
    stream.destroy();
  }

  if (parseError) {
    throw parseError;
  }

  if (!hasNonWhitespace) {
    return undefined;
  }

  rootNode.range = new vscode.Range(new vscode.Position(0, 0), positionAt(totalLength));
  return rootNode;

  function createNodeForFrame(frame: ElementFrame) {
    if (frame.node || !frame.shortName) {
      return;
    }

    const trimmed = frame.shortName.trim();
    if (!trimmed) {
      return;
    }

    const parentNode = arNodeStack[arNodeStack.length - 1];
    const start = clampOffsetByLength(totalLength, frame.startOffset);
    const node: ArxmlNode = {
      name: trimmed,
      arpath: `${parentNode.arpath}/${trimmed}`,
      element: frame.tag,
      file: uri,
      range: new vscode.Range(positionAt(start), positionAt(start)),
      uuid: frame.uuid,
      parent: parentNode,
      children: []
    };

    parentNode.children.push(node);
    frame.node = node;
    arNodeStack.push(node);
  }
}

function sanitizeXmlText(value: string): string {
  if (!value) {
    return value;
  }
  INVALID_XML_CHARS.lastIndex = 0;
  if (!INVALID_XML_CHARS.test(value)) {
    return value;
  }
  INVALID_XML_CHARS.lastIndex = 0;
  return value.replace(INVALID_XML_CHARS, ' ');
}

async function streamParse(parser: ReturnType<typeof saxParser>, text: string, abortSignal?: AbortSignal): Promise<void> {
  let offset = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      try {
        if (abortSignal?.aborted) {
          reject(new Error('Parsing cancelled'));
          return;
        }
        if (offset < text.length) {
          const chunk = text.slice(offset, offset + CHUNK_SIZE);
          parser.write(chunk);
          offset += chunk.length;
          setImmediate(pump);
        } else {
          parser.close();
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    };
    pump();
  });
}

function clampOffset(source: string, offset: number): number {
  if (!Number.isFinite(offset)) {
    return source.length;
  }
  return Math.max(0, Math.min(source.length, offset));
}

function clampOffsetByLength(length: number, offset: number): number {
  if (!Number.isFinite(offset)) {
    return length;
  }
  return Math.max(0, Math.min(length, offset));
}
