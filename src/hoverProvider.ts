import * as vscode from 'vscode';
import { ArxmlNode, ArxmlTreeProvider, getArxmlNodeInfo } from './treeProvider';

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

        const node = await this.findNode(arpath);
        if (node) {
            const json_data = JSON.stringify(getArxmlNodeInfo(node));
            const encodedNodeData = encodeURI(json_data);
            const commandUri = vscode.Uri.parse(`command:arxml-tree-view.gotoNode?${encodedNodeData}`);
            const markdownString = new vscode.MarkdownString(`[${component}:${arpath}](${commandUri})`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        } else {
            const markdownString = new vscode.MarkdownString(`**${arpath}** not found`);
            markdownString.isTrusted = true;
            return new vscode.Hover(markdownString, range);
        }
    }

    // Function to find the node corresponding to the link text (PATH)
    private async findNode(targetLabel: string): Promise<ArxmlNode | undefined> {
        // Get the root node from the tree provider
        const rootNode = await this.treeProvider.getRootNode();

        if (!rootNode) {
            return undefined; // No root node found
        }

        // Split the target label by '/' to get the node labels
        const labels = targetLabel.split('/').filter(label => label.trim() !== '');

        let currentNode = rootNode;
        if (currentNode) {
            for (const label of labels) {
                if (!currentNode.children) {
                    return undefined; // No children nodes found for the current node
                }
                // Find the child node with the matching label
                const foundNode = currentNode.children.find(node => node.name === label);
                if (!foundNode) {
                    return undefined; // Child node with the given label not found
                }
                currentNode = foundNode; // Move to the next level
            }
        }

        return currentNode;
    }
}
