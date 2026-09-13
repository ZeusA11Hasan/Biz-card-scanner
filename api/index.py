"""Vercel FastAPI entrypoint that adapts HTTP requests to the existing Lambda handler."""
import base64
import mimetypes
import re
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

ROOT = Path(__file__).resolve().parent.parent
APPLICATION_DIR = ROOT / 'application'
FRONTEND_DIR = ROOT / 'FrontendBucket'
PUBLIC_DIR = ROOT / 'public'
if str(APPLICATION_DIR) not in sys.path:
    sys.path.insert(0, str(APPLICATION_DIR))

from app import lambda_handler  # noqa: E402

app = FastAPI(title='Folio')

API_ROOTS = {
    'api', 'scan', 'contacts', 'network', 'chat', 'images',
    'vcard', 'profile', 'health', 'auth',
}

PATH_PARAM_PATTERNS = (
    re.compile(r'^/vcard/profile/(?P<slug>[^/]+)$'),
    re.compile(r'^/contacts/(?P<cardId>[^/]+)$'),
    re.compile(r'^/images/(?P<cardId>[^/]+)$'),
    re.compile(r'^/vcard/(?P<cardId>[^/]+)$'),
    re.compile(r'^/profile/(?P<slug>[^/]+)$'),
)


def normalize_path(path: str) -> str:
    value = path or '/'
    if value.startswith('/api/'):
        value = value[4:]
    elif value == '/api':
        value = '/'
    if not value.startswith('/'):
        value = '/' + value
    return value


def path_parameters(path: str):
    for pattern in PATH_PARAM_PATTERNS:
        match = pattern.match(path)
        if match:
            return match.groupdict()
    return None


def is_api_path(path: str) -> bool:
    first = path.lstrip('/').split('/', 1)[0]
    return first in API_ROOTS


def resolve_static(path: str):
    relative = 'index.html' if path in ('', '/') else path.lstrip('/')
    for folder in (FRONTEND_DIR, PUBLIC_DIR):
        candidate = (folder / relative).resolve()
        try:
            candidate.relative_to(folder.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return candidate
    return None


def to_starlette_response(result: dict) -> Response:
    headers = dict(result.get('headers') or {})
    body = result.get('body') or ''
    status = int(result.get('statusCode') or 200)
    if result.get('isBase64Encoded'):
        content = base64.b64decode(body)
        headers.pop('Content-Length', None)
        return Response(content=content, status_code=status, headers=headers)
    if not isinstance(body, (bytes, bytearray)):
        body = str(body)
    return Response(content=body, status_code=status, headers=headers)


@app.get('/api/health')
@app.get('/health')
def health():
    from app import env_any
    from auth import auth_enabled, google_client_id
    from store import storage_kind
    return {
        'ok': True,
        'service': 'folio',
        'vision': bool(env_any('OPENROUTER_API_KEY', 'openrouter_api_key', 'GEMINI_API_KEY')),
        'parser': bool(env_any('OPENROUTER_API_KEY', 'openrouter_api_key', 'DEEPSEEK_API_KEY')),
        'db': storage_kind(),
        'images': 'postgres' if storage_kind() == 'postgres' else 'store',
        'auth': auth_enabled(),
        'google': bool(google_client_id()),
    }


@app.api_route('/{full_path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'])
@app.api_route('/', methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'])
async def proxy(request: Request, full_path: str = ''):
    path = normalize_path(request.url.path)

    if request.method in ('GET', 'HEAD') and not is_api_path(path):
        static_path = resolve_static(request.url.path)
        if static_path:
            media_type, _ = mimetypes.guess_type(str(static_path))
            return FileResponse(static_path, media_type=media_type)

    raw_body = await request.body()
    event = {
        'httpMethod': request.method,
        'path': path,
        'pathParameters': path_parameters(path),
        'queryStringParameters': dict(request.query_params) or {},
        'headers': {key: value for key, value in request.headers.items()},
        'body': raw_body.decode('utf-8') if raw_body else '{}',
        'isBase64Encoded': False,
    }
    result = lambda_handler(event, None)
    return to_starlette_response(result)
