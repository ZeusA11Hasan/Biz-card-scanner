"""Contact + user store: Postgres when configured, otherwise Vercel Blob / /tmp JSON."""
import base64
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from threading import Lock

logger = logging.getLogger(__name__)

STORE_PATH = os.environ.get('FOLIO_STORE_PATH', '/tmp/folio-store.json')
BLOB_PATHNAME = os.environ.get('FOLIO_BLOB_PATH', 'folio-store.json')
_lock = Lock()
_cache = None
_store = None

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:
    psycopg = None
    dict_row = None
    Jsonb = None


def _normalize_postgres_url(url):
    """Accept Supabase/Neon URIs and ensure SSL for hosted Postgres."""
    value = (url or '').strip()
    if not value:
        return ''
    if value.startswith('postgres://'):
        value = 'postgresql://' + value[len('postgres://'):]
    # Hosted providers (Supabase, Neon, Vercel) require TLS
    host = ''
    try:
        host = (urllib.parse.urlparse(value).hostname or '').lower()
    except Exception:
        host = ''
    needs_ssl = any(
        marker in host
        for marker in ('supabase.co', 'supabase.com', 'neon.tech', 'vercel-storage.com', 'pooler.supabase')
    ) or host.endswith('.supabase.co')
    if needs_ssl and 'sslmode=' not in value:
        sep = '&' if '?' in value else '?'
        value = f'{value}{sep}sslmode=require'
    return value


def postgres_url():
    for name in (
        'DATABASE_URL',
        'POSTGRES_URL',
        'POSTGRES_URL_NON_POOLING',
        'DATABASE_URL_UNPOOLED',
        'POSTGRES_PRISMA_URL',
    ):
        value = _normalize_postgres_url(os.environ.get(name) or '')
        if value:
            return value
    return ''


def storage_kind():
    if postgres_url() and psycopg:
        return 'postgres'
    if os.environ.get('BLOB_READ_WRITE_TOKEN') or os.environ.get('FOLIO_BLOB_TOKEN'):
        return 'blob'
    return 'memory'


def _blob_token():
    return os.environ.get('BLOB_READ_WRITE_TOKEN') or os.environ.get('FOLIO_BLOB_TOKEN')


def _blob_api_url(pathname):
    base = os.environ.get('VERCEL_BLOB_API_URL', 'https://blob.vercel-storage.com')
    query = urllib.parse.urlencode({
        'pathname': pathname,
        'addRandomSuffix': 'false',
        'access': 'private',
        'allowOverwrite': 'true',
    })
    return f'{base}/?{query}'


def _blob_headers(include_json=False):
    headers = {
        'Authorization': f'Bearer {_blob_token()}',
        'x-api-version': os.environ.get('FOLIO_BLOB_API_VERSION', '12'),
    }
    if include_json:
        headers['x-content-type'] = 'application/json'
        headers['Content-Type'] = 'application/json'
    return headers


def _load_blob():
    token = _blob_token()
    if not token:
        return None
    url = _blob_api_url(BLOB_PATHNAME)
    req = urllib.request.Request(url, headers=_blob_headers(), method='GET')
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode('utf-8')
            return json.loads(raw) if raw else {'items': [], 'users': []}
    except urllib.error.HTTPError as err:
        if err.code in (404, 400):
            return {'items': [], 'users': []}
        logger.warning('Blob read failed: %s', err)
        return None
    except Exception as err:
        logger.warning('Blob read failed: %s', err)
        return None


def _save_blob(data):
    token = _blob_token()
    if not token:
        return False
    body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(
        _blob_api_url(BLOB_PATHNAME),
        data=body,
        headers=_blob_headers(include_json=True),
        method='PUT',
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read()
        return True
    except Exception as err:
        logger.warning('Blob write failed: %s', err)
        return False


def _load_file():
    if not os.path.exists(STORE_PATH):
        return {'items': [], 'users': []}
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except Exception:
        return {'items': [], 'users': []}


def _save_file(data):
    os.makedirs(os.path.dirname(STORE_PATH) or '.', exist_ok=True)
    with open(STORE_PATH, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)


def _normalize_db(data):
    if not isinstance(data, dict):
        return {'items': [], 'users': [], 'images': {}}
    data.setdefault('items', [])
    data.setdefault('users', [])
    data.setdefault('images', {})
    if not isinstance(data['items'], list):
        data['items'] = []
    if not isinstance(data['users'], list):
        data['users'] = []
    if not isinstance(data['images'], dict):
        data['images'] = {}
    return data


def _load():
    global _cache
    if _cache is not None:
        return _cache
    data = _load_blob()
    if data is None:
        data = _load_file()
    _cache = _normalize_db(data)
    return _cache


def _save(data):
    global _cache
    _cache = _normalize_db(data)
    _save_file(_cache)
    _save_blob(_cache)


def _key_match(item, user_id, card_id):
    return item.get('userId') == user_id and item.get('cardId') == card_id


def _image_key(user_id, card_id, side):
    return f'{user_id}:{card_id}:{(side or "front").lower()}'


class JsonTable:
    def get_item(self, user_id, card_id):
        with _lock:
            data = _load()
            for item in data['items']:
                if _key_match(item, user_id, card_id):
                    return dict(item)
            return None

    def put_item(self, item):
        with _lock:
            data = _load()
            items = data['items']
            payload = dict(item)
            for key in (
                'frontImage', 'backImage', 'originalImageUrl', 'originalBackImageUrl',
                'cachedImageUrl', 'imageDataUrl',
            ):
                payload.pop(key, None)
            for key in ('imageUrl', 'backImageUrl'):
                value = str(payload.get(key) or '')
                if value.startswith('data:'):
                    payload.pop(key, None)
            user_id = payload.get('userId')
            card_id = payload.get('cardId')
            replaced = False
            for idx, existing in enumerate(items):
                if _key_match(existing, user_id, card_id):
                    items[idx] = payload
                    replaced = True
                    break
            if not replaced:
                items.append(payload)
            _save(data)

    def delete_item(self, user_id, card_id):
        with _lock:
            data = _load()
            data['items'] = [
                item for item in data['items']
                if not _key_match(item, user_id, card_id)
            ]
            prefix = f'{user_id}:{card_id}:'
            data['images'] = {
                key: value for key, value in data.get('images', {}).items()
                if not key.startswith(prefix)
            }
            _save(data)

    def put_card_image(self, user_id, card_id, side, image_bytes, content_type='image/jpeg'):
        side_key = (side or 'front').lower()
        payload = bytes(image_bytes or b'')
        if not payload:
            raise ValueError('Empty image')
        with _lock:
            data = _load()
            data['images'][_image_key(user_id, card_id, side_key)] = {
                'content_type': content_type or 'image/jpeg',
                'bytes': base64.b64encode(payload).decode('ascii'),
            }
            _save(data)
        return f'db:{side_key}'

    def get_card_image(self, user_id, card_id, side='front'):
        side_key = (side or 'front').lower()
        with _lock:
            data = _load()
            row = data.get('images', {}).get(_image_key(user_id, card_id, side_key))
            if not row:
                return None
            raw = row.get('bytes') or ''
            try:
                return {
                    'content_type': row.get('content_type') or 'image/jpeg',
                    'bytes': base64.b64decode(raw),
                }
            except Exception:
                return None

    def has_card_image(self, user_id, card_id, side='front'):
        return self.get_card_image(user_id, card_id, side) is not None

    def delete_card_images(self, user_id, card_id):
        with _lock:
            data = _load()
            prefix = f'{user_id}:{card_id}:'
            data['images'] = {
                key: value for key, value in data.get('images', {}).items()
                if not key.startswith(prefix)
            }
            _save(data)

    def query_by_user(self, user_id):
        with _lock:
            data = _load()
            return [dict(item) for item in data['items'] if item.get('userId') == user_id]

    def get_user_by_username(self, username):
        key = (username or '').strip().lower()
        with _lock:
            data = _load()
            for user in data['users']:
                if (user.get('username') or '').strip().lower() == key:
                    return dict(user)
            return None

    def get_user_by_id(self, user_id):
        with _lock:
            data = _load()
            for user in data['users']:
                if user.get('id') == user_id:
                    return dict(user)
            return None

    def get_user_by_google_sub(self, google_sub):
        key = (google_sub or '').strip()
        if not key:
            return None
        with _lock:
            data = _load()
            for user in data['users']:
                if (user.get('google_sub') or '').strip() == key:
                    return dict(user)
            return None

    def get_user_by_email(self, email):
        key = (email or '').strip().lower()
        if not key:
            return None
        with _lock:
            data = _load()
            for user in data['users']:
                if (user.get('email') or '').strip().lower() == key:
                    return dict(user)
            return None

    def create_user(self, user):
        with _lock:
            data = _load()
            data['users'].append(dict(user))
            _save(data)
            return dict(user)

    def update_user(self, user_id, fields):
        allowed = {'google_sub', 'email', 'username', 'password_hash'}
        updates = {key: fields[key] for key in allowed if key in (fields or {})}
        if not updates:
            return self.get_user_by_id(user_id)
        with _lock:
            data = _load()
            for idx, user in enumerate(data['users']):
                if user.get('id') == user_id:
                    updated = dict(user)
                    updated.update(updates)
                    data['users'][idx] = updated
                    _save(data)
                    return dict(updated)
            return None


class PostgresTable:
    def __init__(self, url):
        self.url = url
        self._ready = False

    def _connect(self):
        return psycopg.connect(self.url, row_factory=dict_row, prepare_threshold=None)

    def _ensure(self, conn):
        if self._ready:
            return
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS contacts (
                user_id TEXT NOT NULL,
                card_id TEXT NOT NULL,
                data JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, card_id)
            )
            """
        )
        conn.execute('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL')
        conn.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT')
        conn.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT')
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key
            ON users (google_sub)
            WHERE google_sub IS NOT NULL
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS card_images (
                user_id TEXT NOT NULL,
                card_id TEXT NOT NULL,
                side TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'image/jpeg',
                bytes BYTEA NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, card_id, side)
            )
            """
        )
        conn.commit()
        self._ready = True

    def _user_row(self, conn, query, params):
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None

    def put_card_image(self, user_id, card_id, side, image_bytes, content_type='image/jpeg'):
        side_key = (side or 'front').lower()
        payload = bytes(image_bytes or b'')
        if not payload:
            raise ValueError('Empty image')
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(
                """
                INSERT INTO card_images (user_id, card_id, side, content_type, bytes, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (user_id, card_id, side)
                DO UPDATE SET content_type = EXCLUDED.content_type,
                              bytes = EXCLUDED.bytes,
                              updated_at = NOW()
                """,
                (user_id, card_id, side_key, content_type or 'image/jpeg', payload),
            )
            conn.commit()
        return f'db:{side_key}'

    def get_card_image(self, user_id, card_id, side='front'):
        side_key = (side or 'front').lower()
        with self._connect() as conn:
            self._ensure(conn)
            row = conn.execute(
                """
                SELECT content_type, bytes
                FROM card_images
                WHERE user_id = %s AND card_id = %s AND side = %s
                """,
                (user_id, card_id, side_key),
            ).fetchone()
            if not row or row.get('bytes') is None:
                return None
            return {
                'content_type': row.get('content_type') or 'image/jpeg',
                'bytes': bytes(row['bytes']),
            }

    def has_card_image(self, user_id, card_id, side='front'):
        side_key = (side or 'front').lower()
        with self._connect() as conn:
            self._ensure(conn)
            row = conn.execute(
                """
                SELECT 1 AS ok
                FROM card_images
                WHERE user_id = %s AND card_id = %s AND side = %s
                LIMIT 1
                """,
                (user_id, card_id, side_key),
            ).fetchone()
            return bool(row)

    def delete_card_images(self, user_id, card_id):
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(
                'DELETE FROM card_images WHERE user_id = %s AND card_id = %s',
                (user_id, card_id),
            )
            conn.commit()

    def get_item(self, user_id, card_id):
        with self._connect() as conn:
            self._ensure(conn)
            row = conn.execute(
                'SELECT data FROM contacts WHERE user_id = %s AND card_id = %s',
                (user_id, card_id),
            ).fetchone()
            return dict(row['data']) if row and row.get('data') else None

    def put_item(self, item):
        payload = dict(item)
        # Never persist megabyte data-URLs inside contact JSON — images live in card_images.
        for key in (
            'frontImage', 'backImage', 'originalImageUrl', 'originalBackImageUrl',
            'cachedImageUrl', 'imageDataUrl',
        ):
            payload.pop(key, None)
        for key in ('imageUrl', 'backImageUrl'):
            value = str(payload.get(key) or '')
            if value.startswith('data:'):
                payload.pop(key, None)
        user_id = payload.get('userId')
        card_id = payload.get('cardId')
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(
                """
                INSERT INTO contacts (user_id, card_id, data, updated_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (user_id, card_id)
                DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
                """,
                (user_id, card_id, Jsonb(payload)),
            )
            conn.commit()

    def delete_item(self, user_id, card_id):
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(
                'DELETE FROM contacts WHERE user_id = %s AND card_id = %s',
                (user_id, card_id),
            )
            conn.execute(
                'DELETE FROM card_images WHERE user_id = %s AND card_id = %s',
                (user_id, card_id),
            )
            conn.commit()

    def query_by_user(self, user_id):
        with self._connect() as conn:
            self._ensure(conn)
            rows = conn.execute(
                'SELECT data FROM contacts WHERE user_id = %s',
                (user_id,),
            ).fetchall()
            return [dict(row['data']) for row in rows if row.get('data')]

    def get_user_by_username(self, username):
        key = (username or '').strip().lower()
        with self._connect() as conn:
            self._ensure(conn)
            return self._user_row(
                conn,
                'SELECT id, username, password_hash, created_at, google_sub, email FROM users WHERE lower(username) = %s',
                (key,),
            )

    def get_user_by_id(self, user_id):
        with self._connect() as conn:
            self._ensure(conn)
            return self._user_row(
                conn,
                'SELECT id, username, password_hash, created_at, google_sub, email FROM users WHERE id = %s',
                (user_id,),
            )

    def get_user_by_google_sub(self, google_sub):
        key = (google_sub or '').strip()
        if not key:
            return None
        with self._connect() as conn:
            self._ensure(conn)
            return self._user_row(
                conn,
                'SELECT id, username, password_hash, created_at, google_sub, email FROM users WHERE google_sub = %s',
                (key,),
            )

    def get_user_by_email(self, email):
        key = (email or '').strip().lower()
        if not key:
            return None
        with self._connect() as conn:
            self._ensure(conn)
            return self._user_row(
                conn,
                """
                SELECT id, username, password_hash, created_at, google_sub, email
                FROM users
                WHERE email IS NOT NULL AND email <> '' AND lower(email) = %s
                """,
                (key,),
            )

    def create_user(self, user):
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(
                """
                INSERT INTO users (id, username, password_hash, google_sub, email, created_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                """,
                (
                    user['id'],
                    user['username'],
                    user.get('password_hash'),
                    user.get('google_sub'),
                    user.get('email'),
                ),
            )
            conn.commit()
            return self.get_user_by_id(user['id'])

    def update_user(self, user_id, fields):
        allowed = {'google_sub', 'email', 'username', 'password_hash'}
        updates = {key: fields[key] for key in allowed if key in (fields or {})}
        if not updates:
            return self.get_user_by_id(user_id)
        assignments = ', '.join(f'{column} = %s' for column in updates)
        values = list(updates.values()) + [user_id]
        with self._connect() as conn:
            self._ensure(conn)
            conn.execute(f'UPDATE users SET {assignments} WHERE id = %s', values)
            conn.commit()
            return self.get_user_by_id(user_id)


def get_store():
    global _store
    if _store is not None:
        return _store
    url = postgres_url()
    if url and psycopg:
        try:
            _store = PostgresTable(url)
            logger.info('Using Postgres contact store')
            return _store
        except Exception as err:
            logger.warning('Postgres store unavailable, falling back to JSON: %s', err)
    _store = JsonTable()
    logger.info('Using JSON contact store (%s)', storage_kind())
    return _store
