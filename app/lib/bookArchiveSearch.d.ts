export interface BookArchiveSearchItem {
  id: string;
  title: string;
  filename: string;
  folder: string;
}

export function rankBookMatches<T extends BookArchiveSearchItem>(books: T[], query: string): T[];
