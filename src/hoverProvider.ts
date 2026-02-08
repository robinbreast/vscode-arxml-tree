import * as vscode from 'vscode';
import { ArxmlTreeProvider } from './treeProvider';

export class ArxmlHoverProvider implements vscode.HoverProvider {

    constructor(private treeProvider: ArxmlTreeProvider) { }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        const reference = findReferenceAtPosition(document, position);
        if (!reference) {
            return undefined;
        }

        const { component, arpath, range } = reference;

        const node = await this.treeProvider.findNodeWithArPath(arpath, {
            preferredUri: document.uri.toString(),
            destType: component
        });

        if (node) {
            const commandUri = vscode.Uri.parse(`command:arxml-tree-view.gotoNode?${encodeURIComponent(JSON.stringify({
                arpath,
                preferredUri: document.uri.toString(),
                destType: component
            }))}`);
            const isSameFile = node.file.toString() === document.uri.toString();
            const fileInfo = isSameFile ? '' : `\n\n📄 *${node.file.fsPath.split('/').pop()}*`;
            const markdownString = new vscode.MarkdownString(`[${component}: ${arpath}](${commandUri})${fileInfo}`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        } else {
            const markdownString = new vscode.MarkdownString(`**${arpath}**\n\n*Not found in open files*\n\nℹ️ Open the ARXML file containing this definition to enable navigation`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        }
    }
}

interface ReferenceInfo {
    component: string;
    arpath: string;
    range: vscode.Range;
}

function findReferenceAtPosition(document: vscode.TextDocument, position: vscode.Position): ReferenceInfo | undefined {
    const fullLength = document.getText().length;
    const offset = document.offsetAt(position);
    const windowSize = 4000;
    const startOffset = Math.max(0, offset - windowSize);
    const endOffset = Math.min(fullLength, offset + windowSize);
    const sliceRange = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
    const text = document.getText(sliceRange);
    const regex = /<([A-Za-z0-9:_-]+REF)[\s\S]*?DEST="([^"]+)"[\s\S]*?>([\s\S]*?)<\/\1>/gi;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
        const matchStart = startOffset + match.index;
        const matchEnd = matchStart + match[0].length;
        if (offset >= matchStart && offset <= matchEnd) {
            const component = match[2];
            const arpath = match[3]?.trim();
            if (!component || !arpath) {
                return undefined;
            }
            return {
                component,
                arpath,
                range: new vscode.Range(document.positionAt(matchStart), document.positionAt(matchEnd))
            };
        }
    }

    return undefined;
}
