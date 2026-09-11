import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { AppSettings } from '@shared/types.js'
import { useStore } from '../store/store.js'

/**
 * 地图视图。
 *
 * 这是整个应用**唯一**可能联网的地方，而且默认关着。关闭时不加载任何瓦片，
 * 改成在经纬网格上按地点打气泡 —— 配合地名标签，离线状态下照样看得懂
 * "我在哪些地方拍过照、各拍了多少张"，只是没有底图而已。
 */

/**
 * 经纬网：15° 主线 + 5° 细线。没有底图时这是唯一的空间参照，
 * 只画主线的话放大到一个国家的范围内就一条线都看不见了。
 */
function graticuleLines(step: number): Array<[number, number][]> {
  const out: Array<[number, number][]> = []
  for (let lon = -180; lon <= 180; lon += step) out.push([[-85, lon], [85, lon]])
  for (let lat = -80; lat <= 80; lat += step) out.push([[lat, -180], [lat, 180]])
  return out
}

function Graticule(): React.JSX.Element {
  const minor = useMemo(() => graticuleLines(5), [])
  const major = useMemo(() => graticuleLines(15), [])
  return (
    <>
      {minor.map((pts, i) => (
        <Polyline key={`m${i}`} positions={pts} pathOptions={{ color: '#26262e', weight: 1, interactive: false }} />
      ))}
      {major.map((pts, i) => (
        <Polyline key={`M${i}`} positions={pts} pathOptions={{ color: '#3a3a46', weight: 1, interactive: false }} />
      ))}
    </>
  )
}

function FitToPlaces({ bounds }: { bounds: [[number, number], [number, number]] | null }): null {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [60, 60], maxZoom: 9 })
  }, [bounds, map])
  return null
}

export default function MapView(): React.JSX.Element {
  const places = useStore((s) => s.places)
  const setFilter = useStore((s) => s.setFilter)
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => { void window.gallery.settings.get().then(setSettings) }, [])

  const withCoords = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
  const maxCount = Math.max(1, ...withCoords.map((p) => p.photoCount))

  const bounds = useMemo((): [[number, number], [number, number]] | null => {
    if (!withCoords.length) return null
    const lats = withCoords.map((p) => p.lat)
    const lons = withCoords.map((p) => p.lon)
    return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]]
  }, [withCoords])

  if (withCoords.length === 0) {
    return (
      <div className="empty">
        <h2>没有可以在地图上显示的照片</h2>
        <p>地图展示的是带 GPS 坐标的照片。手机拍的照片如果开了定位权限通常都有，相机拍的一般没有。</p>
      </div>
    )
  }

  const online = settings?.mapOnlineTiles ?? false

  return (
    <div className="map-wrap" style={{ position: 'relative' }}>
      <MapContainer center={[withCoords[0]!.lat, withCoords[0]!.lon]} zoom={4} worldCopyJump>
        {online
          ? <TileLayer url={settings!.tileUrl} attribution="&copy; OpenStreetMap" maxZoom={19} />
          : <Graticule />}
        <FitToPlaces bounds={bounds} />
        {withCoords.map((p) => {
          // 半径按数量的平方根缩放：直接按数量会让大城市的圈盖住半张地图
          const r = 7 + 20 * Math.sqrt(p.photoCount / maxCount)
          return (
            <CircleMarker
              key={p.id}
              center={[p.lat, p.lon]}
              radius={r}
              pathOptions={{ color: '#5b9dff', fillColor: '#5b9dff', fillOpacity: 0.35, weight: 1.5 }}
              eventHandlers={{
                click: () => {
                  useStore.setState({ view: 'timeline' })
                  setFilter({ placeIds: [p.id], favorite: undefined }, false)
                }
              }}
            >
              <Tooltip direction="top" offset={[0, -r]}>
                <strong>{p.customName ?? p.name}</strong><br />
                {p.photoCount.toLocaleString()} 张
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>

      {!online && (
        <div className="map-fallback-note">
          当前是离线模式，没有加载地图底图 —— 气泡的位置是真实坐标，鼠标悬停能看到地名。
          想要真正的底图可以到「设置」里打开在线地图瓦片，那会向 OpenStreetMap 发起网络请求。
        </div>
      )}
    </div>
  )
}
