import * as vscode from 'vscode';
import { TreeFilterConfig } from './treeProvider';

export interface SavedFilter {
  id: string;
  name: string;
  description?: string;
  filter: TreeFilterConfig;
  createdAt: number;
  lastUsed?: number;
}

export class SavedFiltersStore {
  private static readonly STORAGE_KEY = 'arxmlTree.savedFilters';

  constructor(private readonly memento: vscode.Memento) {}

  async saveFilter(name: string, filter: TreeFilterConfig, description?: string): Promise<SavedFilter> {
    const savedFilters = await this.getSavedFilters();
    
    const existingIndex = savedFilters.findIndex(f => f.name === name);
    
    const savedFilter: SavedFilter = {
      id: existingIndex >= 0 ? savedFilters[existingIndex].id : this.generateId(),
      name,
      description,
      filter: { ...filter },
      createdAt: existingIndex >= 0 ? savedFilters[existingIndex].createdAt : Date.now(),
      lastUsed: Date.now()
    };

    if (existingIndex >= 0) {
      savedFilters[existingIndex] = savedFilter;
    } else {
      savedFilters.push(savedFilter);
    }

    savedFilters.sort((a, b) => a.name.localeCompare(b.name));
    
    await this.memento.update(SavedFiltersStore.STORAGE_KEY, savedFilters);
    return savedFilter;
  }

  async getSavedFilters(): Promise<SavedFilter[]> {
    return this.memento.get(SavedFiltersStore.STORAGE_KEY, []);
  }

  async getFilterById(id: string): Promise<SavedFilter | undefined> {
    const filters = await this.getSavedFilters();
    return filters.find(f => f.id === id);
  }

  async deleteFilter(id: string): Promise<void> {
    const filters = await this.getSavedFilters();
    const filteredFilters = filters.filter(f => f.id !== id);
    await this.memento.update(SavedFiltersStore.STORAGE_KEY, filteredFilters);
  }

  async updateLastUsed(id: string): Promise<void> {
    const filters = await this.getSavedFilters();
    const filter = filters.find(f => f.id === id);
    if (filter) {
      filter.lastUsed = Date.now();
      await this.memento.update(SavedFiltersStore.STORAGE_KEY, filters);
    }
  }

  async renameFilter(id: string, newName: string): Promise<void> {
    const filters = await this.getSavedFilters();
    const filter = filters.find(f => f.id === id);
    if (filter) {
      filter.name = newName;
      filters.sort((a, b) => a.name.localeCompare(b.name));
      await this.memento.update(SavedFiltersStore.STORAGE_KEY, filters);
    }
  }

  async updateDescription(id: string, description?: string): Promise<void> {
    const filters = await this.getSavedFilters();
    const filter = filters.find(f => f.id === id);
    if (filter) {
      filter.description = description;
      await this.memento.update(SavedFiltersStore.STORAGE_KEY, filters);
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
  }
}