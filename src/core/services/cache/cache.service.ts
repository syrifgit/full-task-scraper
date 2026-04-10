import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'path';

const GITHUB_API_URL = 'https://api.github.com/repos';
const REPO_OWNER = 'abextm';
const REPO_NAME = 'osrs-cache';
const VERSION_FILE = 'cache-version.txt';
const versionFilePath = path.join('./osrs-cache', 'cache-version.txt');

@Injectable()
export class CacheService {
  public async updateCache(targetCommitHash?: string): Promise<void> {
    const commitToUse = targetCommitHash || await this.getLatestCommitHash();
    await this.downloadRepository(commitToUse);
    this.updateVersionFile(commitToUse);
  }

  // Fetches the contents of a given path in the repository for a specific commit
  private async fetchRepoContents(repoPath: string, commitHash?: string): Promise<any[]> {
    const refParam = commitHash ? `?ref=${commitHash}` : '';
    const url = `${GITHUB_API_URL}/${REPO_OWNER}/${REPO_NAME}/contents/${repoPath}${refParam}`;
    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      console.error(`Error fetching repository contents from ${url}`, error);
      throw error;
    }
  }

  // Downloads a file from the GitHub repo and saves it locally
  private async downloadFile(fileUrl: string, filePath: string): Promise<void> {
    try {
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(filePath, new Uint8Array(response.data));
      console.log(`Downloaded file: ${filePath}`);
    } catch (error) {
      console.error(`Error downloading file from ${fileUrl}`, error);
      throw error;
    }
  }

  // Recursively downloads the contents of a GitHub repository for a specific commit
  private async downloadRepoContents(repoPath: string, localPath: string, commitHash?: string): Promise<void> {
    const contents = await this.fetchRepoContents(repoPath, commitHash);

    for (const item of contents) {
      const itemPath = path.join(localPath, item.name);
      if (item.type === 'dir') {
        // Create the directory locally
        if (!fs.existsSync(itemPath)) {
          fs.mkdirSync(itemPath, { recursive: true });
        }
        // Recursively process the directory
        await this.downloadRepoContents(`${repoPath}/${item.name}`, itemPath, commitHash);
      } else if (item.type === 'file') {
        // Download the file
        await this.downloadFile(item.download_url, itemPath);
      }
    }
  }

  // Main function to download the entire repository for a specific commit
  private async downloadRepository(commitHash?: string): Promise<void> {
    const targetDir = './osrs-cache';
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    try {
      console.log(`Starting repository download${commitHash ? ` for commit ${commitHash}` : ''}...`);
      await this.downloadRepoContents('', targetDir, commitHash);
      console.log('Repository download complete.');
    } catch (error) {
      console.error('Failed to download the repository:', error);
      throw error;
    }
  }

  // Fetches the latest commit hash from the repository
  public async getLatestCommitHash(): Promise<string> {
    const commitsUrl = `${GITHUB_API_URL}/${REPO_OWNER}/${REPO_NAME}/commits`;
    try {
      const response = await axios.get(commitsUrl);
      return response.data[0].sha; // Get the latest commit hash
    } catch (error) {
      console.error(`Error fetching latest commit from ${commitsUrl}`, error);
      throw error;
    }
  }

  // Validates if a commit hash exists in the repository
  public async validateCommitHash(commitHash: string): Promise<boolean> {
    const commitUrl = `${GITHUB_API_URL}/${REPO_OWNER}/${REPO_NAME}/commits/${commitHash}`;
    try {
      await axios.get(commitUrl);
      return true;
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 422) {
        return false;
      }
      console.error(`Error validating commit hash ${commitHash}:`, error.message);
      throw new Error(`Failed to validate commit hash ${commitHash}: ${error.message}`);
    }
  }

  // Updates the version file with the latest commit hash
  private updateVersionFile(version: string): void {
    const versionFilePath = path.join('./osrs-cache', VERSION_FILE);
    fs.writeFileSync(versionFilePath, version);
    console.log(`Updated version file: ${versionFilePath} with version: ${version}`);
  }

  // Gets the current local cache commit hash
  public getLocalCommitHash(): string | null {
    if (!fs.existsSync(versionFilePath)) {
      return null;
    }
    return fs.readFileSync(versionFilePath, 'utf-8').trim();
  }
}
