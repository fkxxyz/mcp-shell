import { chmod, mkdir } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type Shell = {
  id: number;
  cwd: string;
  createdAt: number;
};

type ShellRow = {
  id: number;
  cwd: string;
  created_at: number;
};

export class ShellStore {
  private readonly insertShell: StatementSync;
  private readonly selectShell: StatementSync;
  private readonly selectShellsByCwd: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    this.insertShell = db.prepare("INSERT INTO shells (cwd, created_at) VALUES (?, ?)");
    this.selectShell = db.prepare("SELECT id, cwd, created_at FROM shells WHERE id = ?");
    this.selectShellsByCwd = db.prepare(`
      SELECT id, cwd, created_at
      FROM shells
      WHERE cwd = ? AND (? IS NULL OR id < ?)
      ORDER BY id DESC
      LIMIT ?
    `);
  }

  static async open(configDir: string, dbFile: string): Promise<ShellStore> {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);

    const db = new DatabaseSync(dbFile);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shells (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      await chmod(dbFile, 0o600);
      return new ShellStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  create(cwd: string): Shell {
    const createdAt = Date.now();
    const result = this.insertShell.run(cwd, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      cwd,
      createdAt,
    };
  }

  get(id: number): Shell | undefined {
    const row = this.selectShell.get(id) as ShellRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      cwd: row.cwd,
      createdAt: row.created_at,
    };
  }

  require(id: number): Shell {
    const shell = this.get(id);
    if (!shell) throw new Error(`Unknown shell_id: ${id}`);
    return shell;
  }

  listByCwd(cwd: string, limit: number, beforeId?: number): Shell[] {
    const before = beforeId ?? null;
    const rows = this.selectShellsByCwd.all(cwd, before, before, limit) as ShellRow[];
    return rows.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
