"""JSON contact store for Vercel Hobby (optional Blob, otherwise /tmp)."""
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
            return json.loads(raw) if raw else {'items': []}
    except urllib.error.HTTPError as err:
        if err.code in (404, 400):
            return {'items': []}
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
        return {'items': []}
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except Exception:
        return {'items': []}


def _save_file(data):
    os.makedirs(os.path.dirname(STORE_PATH) or '.', exist_ok=True)
    with open(STORE_PATH, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)


def _load():
    global _cache
    if _cache is not None:
        return _cache
    data = _load_blob()
    if data is None:
        data = _load_file()
    if not isinstance(data, dict) or 'items' not in data:
        data = {'items': []}
    _cache = data
    return _cache


def _save(data):
    global _cache
    _cache = data
    _save_file(data)
    _save_blob(data)


def _key_match(item, user_id, card_id):
    return item.get('userId') == user_id and item.get('cardId') == card_id


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
            user_id = item.get('userId')
            card_id = item.get('cardId')
            replaced = False
            for idx, existing in enumerate(items):
                if _key_match(existing, user_id, card_id):
                    items[idx] = dict(item)
                    replaced = True
                    break
            if not replaced:
                items.append(dict(item))
            _save(data)

    def delete_item(self, user_id, card_id):
        with _lock:
            data = _load()
            data['items'] = [
                item for item in data['items']
                if not _key_match(item, user_id, card_id)
            ]
            _save(data)

    def query_by_user(self, user_id):
        with _lock:
            data = _load()
            return [dict(item) for item in data['items'] if item.get('userId') == user_id]
