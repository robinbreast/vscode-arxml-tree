import * as vscode from 'vscode';
import { parser as saxParser, QualifiedTag } from 'sax';
import { ArxmlNode } from './arxmlNode';

const SHORT_NAME_TAG = 'SHORT-NAME';
const CHUNK_SIZE = 64_000;

interface ElementFrame {
  tag: string;
  startOffset: number;
  uuid?: string;
  node?: ArxmlNode;
  shortName?: string;
}

export async function parseArxmlDocument(
  text: string,
  uri: vscode.Uri,
  positionAt: (offset: number) => vscode.Position
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

  const parser = saxParser(true, { trim: false, normalize: false, position: true });
  const elementStack: ElementFrame[] = [];
  const arNodeStack: ArxmlNode[] = [rootNode];
  let parseError: Error | undefined;

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
    elementStack.push(frame);
  };

  parser.ontext = (value: string) => {
    const frame = elementStack[elementStack.length - 1];
    if (!frame) {
      return;
    }

    if (frame.tag === SHORT_NAME_TAG) {
      frame.shortName = (frame.shortName ?? '') + value;
    }
  };

  parser.onclosetag = () => {
    const frame = elementStack.pop();
    if (!frame) {
      return;
    }

    if (frame.tag === SHORT_NAME_TAG) {
      const parentFrame = elementStack[elementStack.length - 1];
      if (parentFrame) {
        parentFrame.shortName = frame.shortName?.trim() ?? '';
        createNodeForFrame(parentFrame);
      }
      return;
    }

    if (frame.node) {
      const end = clampOffset(text, parser.position);
      frame.node.range = new vscode.Range(frame.node.range.start, positionAt(end));
      if (arNodeStack[arNodeStack.length - 1] === frame.node) {
        arNodeStack.pop();
      }
    }
  };

  await streamParse(parser, text);

  if (parseError) {
    throw parseError;
  }

  rootNode.range = new vscode.Range(new vscode.Position(0, 0), positionAt(text.length));
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
    const start = clampOffset(text, frame.startOffset);
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

async function streamParse(parser: ReturnType<typeof saxParser>, text: string): Promise<void> {
  let offset = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      try {
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
