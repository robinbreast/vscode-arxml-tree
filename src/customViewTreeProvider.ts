import * as vscode from 'vscode';
import { CustomViewConfig, CustomViewStore } from './customViewStore';

export interface CustomViewTreeItem {
  id: string;
  label: string;
  description?: string;
}

export class CustomViewTreeProvider implements vscode.TreeDataProvider<CustomViewTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CustomViewTreeItem | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<CustomViewTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor(private readonly store: CustomViewStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item: CustomViewTreeItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    treeItem.contextValue = 'customViewNode';
    treeItem.tooltip = item.description
      ? `${item.label}
${item.description}`
      : item.label;
    treeItem.command = {
      command: 'arxml-tree-view.applyCustomView',
      title: 'Apply Custom View',
      arguments: [item],
    };
    return treeItem;
  }

  async getChildren(): Promise<CustomViewTreeItem[]> {
    const views = await this.store.list();
    return views.map(view => toTreeItem(view));
  }
}

function toTreeItem(view: CustomViewConfig): CustomViewTreeItem {
  return {
    id: view.id,
    label: view.name,
    description: view.description,
  };
}
