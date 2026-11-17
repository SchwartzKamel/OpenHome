import type { RemoteBackend, User } from '@openhome-core/remote'
import AccountControls from './AccountControls'
import BackupControls from './BackupControls'
import FolderControls from './FolderControls'

export default function HumanTools({ backend, user }: { backend: RemoteBackend; user: User }) {
  return (
    <div className="remote-tools">
      <AccountControls backend={backend} user={user} />
      <BackupControls backend={backend} />
      <FolderControls backend={backend} />
    </div>
  )
}
