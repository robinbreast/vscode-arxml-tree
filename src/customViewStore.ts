import * as vscode from 'vscode';
import * as path from 'path';

const CUSTOM_VIEW_KEY = 'arxmlTree.customViews';
const CUSTOM_VIEW_SEEDED_KEY = 'arxmlTree.customViewsSeeded';
const BUNDLED_VIEWS_PATH = 'resources/customViews.json';
const WORKSPACE_VIEWS_FILE = '.vscode/arxmlTree.customViews.json';
const GLOBAL_VIEWS_FILE = 'customViews.json';

export type CustomViewUuidFilter = 'present' | 'missing';
export type CustomViewSort = 'name' | 'arpath';
export type CustomViewParseMode = 'strict' | 'lenient';

export interface CustomViewConfig {
  id: string;
  name: string;
  description?: string;
  filters: {
    arpathPrefix?: string;
    elementTags?: string[];
    textContains?: string;
    uuidFilter?: CustomViewUuidFilter;
  };
  nameTags?: string[];
  nameTextTags?: string[];
  parseMode?: CustomViewParseMode;
  sort?: CustomViewSort;
}

export interface ImportOptions {
  skipConflicts?: boolean;
  overwriteConflicts?: boolean;
  generateNewIds?: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ viewName: string; error: string }>;
  conflicts: Array<{ type: string; viewName: string; existingId: string; importedId: string }>;
}

export interface ImportData {
  version: string;
  exportedAt: string;
  extensionVersion: string;
  views: CustomViewConfig[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class CustomViewStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensureSeeded(): Promise<void> {
    const storage = this.getStorage();
    const seeded = storage.get<boolean>(CUSTOM_VIEW_SEEDED_KEY, false);
    const fileUri = this.getStorageFileUri();
    if (!fileUri) {
      return;
    }
    const bundled = await this.loadBundledViews();
    const exists = await fileExists(fileUri);
    if (seeded) {
      if (!exists) {
        if (bundled.length > 0) {
          await this.saveAll(bundled);
        } else {
          await this.saveAll([]);
        }
      } else {
        const current = await this.getAll();
        if (current.length === 0 && bundled.length > 0) {
          await this.saveAll(bundled);
        } else {
          const updated = this.mergeBundledDefaults(current, bundled);
          if (updated.changed) {
            await this.saveAll(updated.views);
          }
        }
      }
      return;
    }
    try {
      if (!exists) {
        if (bundled.length > 0) {
          await this.saveAll(bundled);
        } else {
          await this.saveAll([]);
        }
      }
      await storage.update(CUSTOM_VIEW_SEEDED_KEY, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to load bundled custom views: ${message}`);
    }
  }

  async list(): Promise<CustomViewConfig[]> {
    return [...await this.getAll()];
  }

  async getById(id: string): Promise<CustomViewConfig | undefined> {
    const views = await this.getAll();
    return views.find(view => view.id === id);
  }

  async create(input: Omit<CustomViewConfig, 'id'>): Promise<CustomViewConfig> {
    const next: CustomViewConfig = {
      ...input,
      id: generateId(),
    };
    const views = await this.getAll();
    views.push(next);
    await this.saveAll(views);
    return next;
  }

  async update(id: string, input: Omit<CustomViewConfig, 'id'>): Promise<CustomViewConfig | undefined> {
    const views = await this.getAll();
    const index = views.findIndex(view => view.id === id);
    if (index < 0) {
      return undefined;
    }
    const next: CustomViewConfig = { ...input, id };
    views[index] = next;
    await this.saveAll(views);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const views = await this.getAll();
    const next = views.filter(view => view.id !== id);
    if (next.length === views.length) {
      return false;
    }
    await this.saveAll(next);
    return true;
  }

  getStorageFileUri(): vscode.Uri | undefined {
    const scope = vscode.workspace.getConfiguration('arxmlTree').get<'workspace' | 'global'>('customViewStorageScope', 'workspace');
    if (scope === 'workspace') {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        return vscode.Uri.joinPath(folder.uri, WORKSPACE_VIEWS_FILE);
      }
    }
    return vscode.Uri.joinPath(this.context.globalStorageUri, GLOBAL_VIEWS_FILE);
  }

  async exportToFile(targetUri: vscode.Uri, viewIds?: string[]): Promise<void> {
    const allViews = await this.getAll();
    const viewsToExport = viewIds 
      ? allViews.filter(view => viewIds.includes(view.id))
      : allViews;

    if (viewsToExport.length === 0) {
      throw new Error('No views to export');
    }

    const exportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      extensionVersion: this.context.extension.packageJSON.version,
      views: viewsToExport
    };

    const payload = JSON.stringify(exportData, null, 2);
    const directory = vscode.Uri.file(path.dirname(targetUri.fsPath));
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(payload, 'utf8'));
  }

  async exportSelectedViews(viewIds: string[]): Promise<string> {
    const allViews = await this.getAll();
    const viewsToExport = allViews.filter(view => viewIds.includes(view.id));

    if (viewsToExport.length === 0) {
      throw new Error('No views selected for export');
    }

    const exportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      extensionVersion: this.context.extension.packageJSON.version,
      views: viewsToExport
    };

    return JSON.stringify(exportData, null, 2);
  }

  async exportAllViews(): Promise<string> {
    const allViews = await this.getAll();

    if (allViews.length === 0) {
      throw new Error('No views available to export');
    }

    const exportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      extensionVersion: this.context.extension.packageJSON.version,
      views: allViews
    };

    return JSON.stringify(exportData, null, 2);
  }

  async importFromFile(sourceUri: vscode.Uri, options: ImportOptions = {}): Promise<ImportResult> {
    try {
      const bytes = await vscode.workspace.fs.readFile(sourceUri);
      const raw = Buffer.from(bytes).toString('utf8');
      const data = JSON.parse(raw);

      return await this.importFromData(data, options);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to read import file: ${error.message}`);
      }
      throw new Error('Failed to read import file: Unknown error');
    }
  }

  async importFromData(data: any, options: ImportOptions = {}): Promise<ImportResult> {
    const validationResult = this.validateImportData(data);
    if (!validationResult.valid) {
      throw new Error(`Invalid import data: ${validationResult.errors.join(', ')}`);
    }

    const importData = data as ImportData;
    const existingViews = await this.getAll();
    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      errors: [],
      conflicts: []
    };

    for (const view of importData.views) {
      try {
        const existingView = existingViews.find(v => v.id === view.id || v.name === view.name);
        
        if (existingView) {
          if (options.skipConflicts) {
            result.skipped++;
            result.conflicts.push({
              type: 'duplicate',
              viewName: view.name,
              existingId: existingView.id,
              importedId: view.id
            });
            continue;
          } else if (options.overwriteConflicts) {
            await this.update(existingView.id, view);
            result.imported++;
          } else {
            result.conflicts.push({
              type: 'duplicate',
              viewName: view.name,
              existingId: existingView.id,
              importedId: view.id
            });
            result.skipped++;
          }
        } else {
          const newView: CustomViewConfig = {
            ...view,
            id: options.generateNewIds ? generateId() : view.id
          };
          await this.create(newView);
          result.imported++;
        }
      } catch (error) {
        result.errors.push({
          viewName: view.name,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return result;
  }

  private validateImportData(data: any): ValidationResult {
    const errors: string[] = [];

    if (!data || typeof data !== 'object') {
      errors.push('Invalid JSON format');
      return { valid: false, errors };
    }

    if (!data.views || !Array.isArray(data.views)) {
      errors.push('Missing or invalid "views" array');
      return { valid: false, errors };
    }

    if (data.views.length === 0) {
      errors.push('No views found in import data');
      return { valid: false, errors };
    }

    for (let i = 0; i < data.views.length; i++) {
      const view = data.views[i];
      const viewErrors = this.validateCustomViewConfig(view, `View ${i + 1}`);
      errors.push(...viewErrors);
    }

    return { valid: errors.length === 0, errors };
  }

  private validateCustomViewConfig(view: any, prefix: string): string[] {
    const errors: string[] = [];

    if (!view || typeof view !== 'object') {
      errors.push(`${prefix}: Invalid view object`);
      return errors;
    }

    if (!view.id || typeof view.id !== 'string') {
      errors.push(`${prefix}: Missing or invalid "id" field`);
    }

    if (!view.name || typeof view.name !== 'string') {
      errors.push(`${prefix}: Missing or invalid "name" field`);
    }

    if (view.description !== undefined && typeof view.description !== 'string') {
      errors.push(`${prefix}: Invalid "description" field (must be string or undefined)`);
    }

    if (!view.filters || typeof view.filters !== 'object') {
      errors.push(`${prefix}: Missing or invalid "filters" object`);
    } else {
      if (view.filters.arpathPrefix !== undefined && typeof view.filters.arpathPrefix !== 'string') {
        errors.push(`${prefix}: Invalid "filters.arpathPrefix" (must be string or undefined)`);
      }
      
      if (view.filters.elementTags !== undefined) {
        if (!Array.isArray(view.filters.elementTags) || !view.filters.elementTags.every((tag: any) => typeof tag === 'string')) {
          errors.push(`${prefix}: Invalid "filters.elementTags" (must be string array or undefined)`);
        }
      }
      
      if (view.filters.textContains !== undefined && typeof view.filters.textContains !== 'string') {
        errors.push(`${prefix}: Invalid "filters.textContains" (must be string or undefined)`);
      }
      
      if (view.filters.uuidFilter !== undefined && !['present', 'missing'].includes(view.filters.uuidFilter)) {
        errors.push(`${prefix}: Invalid "filters.uuidFilter" (must be "present", "missing", or undefined)`);
      }
    }

    if (view.parseMode !== undefined && !['strict', 'lenient'].includes(view.parseMode)) {
      errors.push(`${prefix}: Invalid "parseMode" (must be "strict", "lenient", or undefined)`);
    }

    if (view.sort !== undefined && !['name', 'arpath'].includes(view.sort)) {
      errors.push(`${prefix}: Invalid "sort" (must be "name", "arpath", or undefined)`);
    }

    return errors;
  }

  private async getAll(): Promise<CustomViewConfig[]> {
    const uri = this.getStorageFileUri();
    if (!uri) {
      return [];
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = Buffer.from(bytes).toString('utf8');
      const parsed = JSON.parse(raw) as CustomViewConfig[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(view => Boolean(view?.id && view?.name));
    } catch (error) {
      if (isFileMissing(error)) {
        return [];
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to read custom views file: ${message}`);
      return [];
    }
  }

  private async saveAll(views: CustomViewConfig[]): Promise<void> {
    const uri = this.getStorageFileUri();
    if (!uri) {
      return;
    }
    const directory = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(directory);
    const payload = JSON.stringify(views, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
  }

  private getStorage(): vscode.Memento {
    const scope = vscode.workspace.getConfiguration('arxmlTree').get<'workspace' | 'global'>('customViewStorageScope', 'workspace');
    return scope === 'global' ? this.context.globalState : this.context.workspaceState;
  }

  private async loadBundledViews(): Promise<CustomViewConfig[]> {
    const uri = vscode.Uri.joinPath(this.context.extensionUri, BUNDLED_VIEWS_PATH);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const raw = Buffer.from(bytes).toString('utf8');
    const parsed = JSON.parse(raw) as CustomViewConfig[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(view => Boolean(view?.id && view?.name));
  }

  private mergeBundledDefaults(views: CustomViewConfig[], bundled: CustomViewConfig[]): { views: CustomViewConfig[]; changed: boolean } {
    if (bundled.length === 0 || views.length === 0) {
      return { views, changed: false };
    }
    let changed = false;
    const next = views.map(view => {
      const builtin = bundled.find(candidate => candidate.id === view.id);
      if (!builtin) {
        return view;
      }
      const merged: CustomViewConfig = { ...view, filters: { ...view.filters } };
      if (!merged.description && builtin.description) {
        merged.description = builtin.description;
        changed = true;
      }
      if (!merged.nameTags && builtin.nameTags) {
        merged.nameTags = builtin.nameTags;
        changed = true;
      }
      if (!merged.nameTextTags && builtin.nameTextTags) {
        merged.nameTextTags = builtin.nameTextTags;
        changed = true;
      }
      if (!merged.parseMode && builtin.parseMode) {
        merged.parseMode = builtin.parseMode;
        changed = true;
      }
      return merged;
    });
    return { views: next, changed };
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === 'FileNotFound' || error.code === 'FileIsADirectory';
  }
  return false;
}
