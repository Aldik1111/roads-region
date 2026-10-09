# Подготовка к размещению и резервные копии

## Текущий режим

Приложение работает локально. Для Android используется существующий локальный HTTPS и инструкция [PHONE-TEST.md](PHONE-TEST.md). Публичный сервер и домен ещё не выбраны. Конфигурация ниже подготовлена для отдельного сервера с Docker; контейнеры в этой сессии не запускались, потому что Docker Engine недоступен. Проверена структура Compose, а API проверен на SQLite. PostgreSQL и получение публичного сертификата требуют проверки на выбранном сервере.

## Публичный HTTPS — следующий этап

1. Выбрать сервер и домен, направить DNS на сервер. Открыть входящие TCP 80/443. Порты базы и приложения наружу не публикуются.
2. На Linux-сервере создать конфигурацию: `python tools/init_deploy.py --domain roads.example.com`. Подставить свой домен. Команда создаёт `.env.production` с уникальным паролем базы, не выводит его и отказывается перезаписывать существующий файл. Права POSIX — 0600 с момента создания. На Windows права наследуются из ACL папки: использовать только приватную папку своего пользователя, при необходимости ограничить ACL вручную. Файл исключён из Git.
3. Проверить и запустить:

```sh
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml ps
```

Caddy настроен на автоматический HTTPS; его сертификаты сохраняются в отдельном томе. Требования к DNS, портам и хранению сертификатов описаны в [документации Caddy](https://caddyserver.com/docs/automatic-https).

Новая PostgreSQL-база запускается без демонстрационных пользователей (`ROADS_DEMO_MODE=false`). Данные локальной SQLite автоматически не переносятся. До реального перехода нужен отдельный план переноса и проверка всех фото/истории. Образы контейнеров и зависимости следует обновлять в рамках обслуживания.

## Личные учётные записи

Создать пользователей на запущенном сервере:

```sh
docker compose --env-file .env.production -f compose.production.yaml exec app python tools/manage_users.py create --email dispatcher@example.com --name "Диспетчер" --role dispatcher
docker compose --env-file .env.production -f compose.production.yaml exec app python tools/manage_users.py create --email inspector@example.com --name "Инспектор" --role inspector
docker compose --env-file .env.production -f compose.production.yaml exec app python tools/manage_users.py create --email contractor@example.com --name "Подрядчик" --role contractor --contractor-id contractor-company-1
docker compose --env-file .env.production -f compose.production.yaml exec app python tools/manage_users.py reset-password --email inspector@example.com
```

Пароль вводится скрыто дважды, минимум 12 символов; его нет в аргументах команд. Сброс пароля завершает существующие сеансы. Для локальной базы можно передать `--database-url sqlite:///backend/roads.db` перед подкомандой. Новые личные пользователи пока не созданы: нужны реальные имена, адреса и пароли. Самостоятельной регистрации и восстановления через почту нет.

## Резервная копия локальной SQLite

Из корня проекта:

```powershell
.\.venv\Scripts\python.exe tools/backup.py create --database backend/roads.db --photos backend/uploads --extra-photo-root backend/demo_photos --destination backups/manual-20261010
.\.venv\Scripts\python.exe tools/backup.py verify backups/manual-20261010
.\.venv\Scripts\python.exe tools/backup.py restore backups/manual-20261010 work/restore-check
```

Каждой копии нужна новая папка. Используется согласованный снимок SQLite и копии всех связанных оригиналов фото; проверяются SHA-256 и целостность базы. Рабочая база не заменяется. Восстановление выполняется только в новую/пустую папку, пути фотографий в восстановленной базе переписываются. Незавершённая копия помечается `INCOMPLETE`.

Перед этими улучшениями создана и проверена `backups/pre-improvements-20261010`, восстановлена отдельно в `work/restore-check-20261010`: 16 фотографий, хэши и SQLite integrity check совпали. Резервные копии содержат персональные данные и сеансы: держать их вне Git, с ограниченным доступом и копией на другом носителе. Автоматическое расписание пока не включено.

Этот инструмент предназначен для SQLite. Для production PostgreSQL нужен отдельный согласованный процесс `pg_dump` и архива тома фотографий с проверкой восстановления; перед запуском с реальными данными это обязательный этап. Наличие Docker-тома само по себе не является резервной копией.

## Офлайн-карта и GPS на трассе

Очередь и геометрия маршрута уже сохраняются локально. Полная офлайн-подложка требует выбранного источника с правами на скачивание: публичные тайлы OSM запрещают массовую предзагрузку и офлайн-скачивание — [правила OSM](https://operations.osmfoundation.org/policies/tiles/). Другой онлайн-источник можно задать через `VITE_MAP_TILE_URL` и `VITE_MAP_TILE_ATTRIBUTION` при сборке; секретные ключи нельзя помещать во frontend.

Запись браузерного GPS при заблокированном экране не гарантируется. Для такого режима нужен отдельный Android-клиент с разрешениями и foreground service — [документация Android](https://developer.android.com/develop/sensors-and-location/location/permissions). До этого полевой тест проводится с открытой вкладкой: маршрут, потеря связи, восстановление GPS, очередь фото и приёмка ремонта. Эмуляция в тестах не заменяет поездку с реальным телефоном.
