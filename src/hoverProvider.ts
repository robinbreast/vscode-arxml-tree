import * as vscode from 'vscode';
import { ArxmlNode, ArxmlTreeProvider } from './treeProvider';
import { setEngine } from 'crypto';

export class ArxmlHoverProvider implements vscode.HoverProvider {

    constructor(private treeProvider: ArxmlTreeProvider) { }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        const regex = /<[^>]+?REF DEST="([^"]*?)">([^<]*?)<\/[^>]+?REF>/;
        const range = document.getWordRangeAtPosition(position, regex);
        if (!range) {
            return undefined;
        }

        const text = document.getText(range);
        const match = regex.exec(text);
        if (!match) {
            return undefined;
        }

        const component = match[1];
        const arpath = match[2];

        const node = await this.treeProvider.findNodeWithArPath(arpath);
        if (node) {
            const commandUri = vscode.Uri.parse(`command:arxml-tree-view.gotoNode?${encodeURIComponent(JSON.stringify(arpath))}`);
            const markdownString = new vscode.MarkdownString(`[${component}:${arpath}](${commandUri})`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        } else {
            const markdownString = new vscode.MarkdownString(`**${arpath}** not found`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        }
    }
}
