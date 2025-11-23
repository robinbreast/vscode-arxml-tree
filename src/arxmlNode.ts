import * as vscode from 'vscode';

export interface ArxmlNode {
  name: string;
  arpath: string;
  element: string;
  file: vscode.Uri;
  range: vscode.Range;
  uuid?: string;
  parent?: ArxmlNode;
  children: ArxmlNode[];
}

export function equalsArxmlNodes(node1: ArxmlNode, node2: ArxmlNode): boolean {
  return (
    node1.arpath === node2.arpath &&
    node1.element === node2.element &&
    node1.file.fsPath === node2.file.fsPath
  );
}
