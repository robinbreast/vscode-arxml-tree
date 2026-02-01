import * as vscode from 'vscode';
import { TreeFilterConfig } from './treeProvider';

export interface SearchHistoryItem {
  id: string;
  timestamp: number;
  filter: TreeFilterConfig;
  label: string;
}

export class SearchHistoryStore {
  private static readonly STORAGE_KEY = 'arxmlTree.searchHistory';
  private static readonly MAX_HISTORY_ITEMS = 20;

  constructor(private readonly memento: vscode.Memento) {}

  async addSearch(filter: TreeFilterConfig): Promise<void> {
    const history = await this.getHistory();
    
    const label = this.generateLabel(filter);
    const item: SearchHistoryItem = {
      id: this.generateId(),
      timestamp: Date.now(),
      filter: { ...filter },
      label
    };

    const existingIndex = history.findIndex(h => this.filtersEqual(h.filter, filter));
    if (existingIndex >= 0) {
      history.splice(existingIndex, 1);
    }

    history.unshift(item);

    if (history.length > SearchHistoryStore.MAX_HISTORY_ITEMS) {
      history.splice(SearchHistoryStore.MAX_HISTORY_ITEMS);
    }

    await this.memento.update(SearchHistoryStore.STORAGE_KEY, history);
  }

  async getHistory(): Promise<SearchHistoryItem[]> {
    return this.memento.get(SearchHistoryStore.STORAGE_KEY, []);
  }

  async removeItem(id: string): Promise<void> {
    const history = await this.getHistory();
    const filteredHistory = history.filter(item => item.id !== id);
    await this.memento.update(SearchHistoryStore.STORAGE_KEY, filteredHistory);
  }

  async clearHistory(): Promise<void> {
    await this.memento.update(SearchHistoryStore.STORAGE_KEY, []);
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }

  private generateLabel(filter: TreeFilterConfig): string {
    const parts: string[] = [];
    const nameMode = filter.nameMode ?? filter.mode;
    const arpathMode = filter.arpathMode ?? filter.mode;
    const elementMode = filter.elementMode ?? filter.mode;
    
    if (filter.name) {
      parts.push(`Name (${nameMode}): ${filter.name}`);
    }
    if (filter.arpath) {
      parts.push(`Path (${arpathMode}): ${filter.arpath}`);
    }
    if (filter.element) {
      parts.push(`Element (${elementMode}): ${filter.element}`);
    }
    
    if (parts.length === 0) {
      return `Mode: ${filter.mode}`;
    }
    
    const label = parts.join(', ');
    return label.length > 50 ? label.substring(0, 47) + '...' : label;
  }

  private filtersEqual(a: TreeFilterConfig, b: TreeFilterConfig): boolean {
    return (
      a.mode === b.mode &&
      a.nameMode === b.nameMode &&
      a.arpathMode === b.arpathMode &&
      a.elementMode === b.elementMode &&
      a.name === b.name &&
      a.arpath === b.arpath &&
      a.element === b.element
    );
  }
}
