export class FolderNotEmpty extends Error {
  constructor(message = 'Folder is not empty.') {
    super(message)
  }
}
