import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = './osrs-cache';
const CACHE_VERSION_FILE = path.join(CACHE_DIR, 'cache-version.txt');
const REPO_API = 'https://api.github.com/repos/abextm/osrs-cache';

interface GitHubCommit {
  sha: string;
}

interface GitHubContentsItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
  url?: string;
}

export async function getLatestCommitHash(): Promise<string> {
  const response = await axios.get<GitHubCommit[]>(`${REPO_API}/commits`, {
    params: { per_page: 1 },
  });
  return response.data[0].sha;
}

export function getLocalCommitHash(): string | null {
  try {
    if (fs.existsSync(CACHE_VERSION_FILE)) {
      return fs.readFileSync(CACHE_VERSION_FILE, 'utf-8').trim();
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

export async function downloadCache(commitHash?: string): Promise<void> {
  const hash = commitHash || (await getLatestCommitHash());

  // Ensure cache dir exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  console.log(`Downloading OSRS cache from commit ${hash}...`);
  await downloadContents('', CACHE_DIR, hash);

  // Write the commit hash to version file
  fs.writeFileSync(CACHE_VERSION_FILE, hash, 'utf-8');
  console.log(`Cache downloaded and stored at ${CACHE_DIR}`);
}

async function downloadContents(
  repoPath: string,
  localPath: string,
  commitHash: string,
): Promise<void> {
  const url = repoPath
    ? `${REPO_API}/contents/${repoPath}?ref=${commitHash}`
    : `${REPO_API}/contents?ref=${commitHash}`;

  const response = await axios.get<GitHubContentsItem[]>(url);
  const items = response.data;

  for (const item of items) {
    const itemLocalPath = path.join(localPath, item.name);

    if (item.type === 'dir') {
      // Create directory and recurse
      if (!fs.existsSync(itemLocalPath)) {
        fs.mkdirSync(itemLocalPath, { recursive: true });
      }
      await downloadContents(item.path, itemLocalPath, commitHash);
    } else if (item.type === 'file' && item.download_url) {
      // Download file
      console.log(`Downloading ${item.path}...`);
      const fileResponse = await axios.get(item.download_url, {
        responseType: 'arraybuffer',
      });
      fs.writeFileSync(itemLocalPath, Buffer.from(fileResponse.data));
    }
  }
}
