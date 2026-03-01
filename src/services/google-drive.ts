import { google } from 'googleapis';
import path from 'path';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const CTX = 'GoogleDrive';

function getAuth() {
  if (!env.GOOGLE_SERVICE_ACCOUNT_PATH) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_PATH not configured');
  }
  const keyPath = path.resolve(env.GOOGLE_SERVICE_ACCOUNT_PATH);
  return new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

export async function createDriveFolder(
  folderName: string,
  parentFolderId?: string
): Promise<string> {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : undefined,
    },
    fields: 'id',
  });

  const folderId = res.data.id!;
  logger.info(CTX, `Folder created: ${folderName}`, { id: folderId });
  return folderId;
}

export async function createClientFolderStructure(clientName: string): Promise<string> {
  const rootId = env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID not configured');

  const clientFolderId = await createDriveFolder(clientName, rootId);

  const subfolders = [
    '01-Onboarding',
    '02-Configuração',
    '03-Templates',
    '04-Relatórios',
    '05-Assets',
  ];

  for (const sub of subfolders) {
    await createDriveFolder(sub, clientFolderId);
  }

  logger.info(CTX, `Full folder structure created for: ${clientName}`);
  return clientFolderId;
}
