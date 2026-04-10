/**
 * Manages leagues/index.json metadata.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { LeagueMetadata } from './types';

const LEAGUES_FILE = './leagues/index.json';

export function loadLeagues(): LeagueMetadata[] {
  if (!existsSync(LEAGUES_FILE)) return [];
  return JSON.parse(readFileSync(LEAGUES_FILE, 'utf-8'));
}

export function saveLeagues(leagues: LeagueMetadata[]): void {
  writeFileSync(LEAGUES_FILE, JSON.stringify(leagues, null, 2) + '\n');
}

/** Find the league marked as active */
export function findActiveLeague(): LeagueMetadata | null {
  return loadLeagues().find(l => l.active && l.taskTypeName) ?? null;
}

/** Find a league by its taskTypeName (case-insensitive) */
export function findLeagueByTaskType(taskTypeName: string): LeagueMetadata | null {
  return loadLeagues().find(
    l => l.taskTypeName?.toUpperCase() === taskTypeName.toUpperCase(),
  ) ?? null;
}

/** Resolve the output directory for a league */
export function resolveOutputDir(taskTypeName: string): string {
  const league = findLeagueByTaskType(taskTypeName);
  if (league) return path.join('./leagues', league.dir);
  return './generated';
}

/** Update fields on a league entry */
export function updateLeague(taskTypeName: string, updates: Partial<LeagueMetadata>): void {
  const leagues = loadLeagues();
  const league = leagues.find(
    l => l.taskTypeName?.toUpperCase() === taskTypeName.toUpperCase(),
  );
  if (league) {
    Object.assign(league, updates);
    saveLeagues(leagues);
  }
}

/** Check if a league has ended (endDate is set and in the past) */
export function isLeagueEnded(taskTypeName: string): boolean {
  const league = findLeagueByTaskType(taskTypeName);
  if (!league?.endDate) return false;
  return new Date(league.endDate) < new Date();
}

/** Get wiki config for a task type */
export function getWikiConfig(taskTypeName: string): { url: string; taskIdAttribute: string } | null {
  const league = findLeagueByTaskType(taskTypeName);
  if (league?.wikiUrl) {
    return { url: league.wikiUrl, taskIdAttribute: 'data-taskid' };
  }
  return null;
}
