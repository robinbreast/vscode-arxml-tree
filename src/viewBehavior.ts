import * as vscode from 'vscode';
import { ArxmlNode } from './arxmlNode';
import { CustomViewConfig } from './customViewStore';

export interface DiagnosticServiceSummary {
  diagClass: string;
  diagInstance: string;
  serviceName: string;
  semantic: string;
  sid: string;
  did: string;
  serviceType: string;
  identifierKind: string;
  identifier: string;
  subFunction: string;
  dataLength: string;
  request: string;
  responses: string;
  file: string;
  line: number;
  column: number;
  arpath: string;
}

export interface TreeItemPresentation {
  label: string;
  description?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  tooltip: string;
}

export interface ViewBehavior {
  id: string;
  matches(view?: CustomViewConfig): boolean;
  presentNode(node: ArxmlNode, view?: CustomViewConfig): TreeItemPresentation | undefined;
  collectServiceSummaries?(root: ArxmlNode): DiagnosticServiceSummary[];
}
