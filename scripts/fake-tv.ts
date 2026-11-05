// A pretend Sony TV on 127.0.0.1:5556 for trying the app without a real TV:
//   npx tsx scripts/fake-tv.ts      then connect to 127.0.0.1:5556 in the app
import { readFileSync } from 'node:fs'
import { newTv, startFakeAdbd } from '../tests/fake-adbd'

const tv = newTv()
const apps = ['com.netflix.ninja', 'com.google.android.youtube.tv', 'com.amazon.amazonvideo.livingroom', 'com.disney.disneyplus',
  'com.spotify.tv.android', 'com.plexapp.android', 'tv.twitch.android.app', 'com.apple.atve.androidtv.appletv', 'org.videolan.vlc',
  'com.sony.dtv.tvlin', 'com.google.android.youtube.tvmusic', 'com.android.vending']
tv.leanback = apps
for (const p of [...apps, 'com.google.android.apps.tv.launcherx', 'com.google.android.tungsten.setupwraith', 'com.android.tv.settings',
  'com.sony.dtv.bravialifehack', 'com.sony.dtv.discovery', 'com.google.android.apps.tv.dreamx', 'com.google.android.feedback',
  'com.sony.dtv.promos', 'com.netflix.partner.activation', 'com.google.android.tts']) tv.packages.set(p, 'enabled')
tv.home = 'com.google.android.apps.tv.launcherx/.home.HomeActivity'
tv.homeClaims = ['com.google.android.apps.tv.launcherx/.home.HomeActivity', 'com.google.android.tungsten.setupwraith/.RecoveryActivity']
tv.maxData = 256 * 1024
if (process.argv[2]) tv.screenshot = readFileSync(process.argv[2])
const port = Number(process.env.PORT ?? 5556)
startFakeAdbd(tv, port).then(() => console.log(`fake TV listening on 127.0.0.1:${port}`))
