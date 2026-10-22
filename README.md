# POLIGON 3.0 — сервер мультиплеера

## Запуск

```powershell
npm install
npm start
```

Сервер слушает `PORT` (по умолчанию 3000) и отдаёт WebSocket. Для Render:
Web Service, start command `node server.js`, Node 18+.

## Файлы

- `server.js` — WebSocket-сервер: комнаты, состояние игроков, карта, оружие, эмоции, гранаты, spawn protection.
- `package.json` — зависимость `ws`.
- `grenades.test.js` — тест протокола гранат (`npm test`).

## Совместимость

Клиент 3.0 использует тот же протокол, что 1.x: добавлены только новые id эмоций и поля
`model`, `crouched`, `grounded`, `hasAnimationState`, `emote`, `emoteTime`.
Отдача, графика и оптимизация считаются на клиенте и сервер не затрагивают.

После обновления залейте эти файлы на хостинг и перезапустите процесс.
