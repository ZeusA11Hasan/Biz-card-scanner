"""Username/password auth with HMAC JWTs, plus Google sign-in."""
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from store import get_store

logger = logging.getLogger(__name__)

USERNAME_RE = re.compile(r'^[a-zA-Z0-9._-]{3,32}$')
TOKEN_HOURS = 90 * 24
COOKIE_NAME = 'folio_session'
GOOGLE_ISSUERS = {'accounts.google.com', 'https://accounts.google.com'}


def jwt_secret():
    return (os.environ.get('FOLIO_JWT_SECRET') or os.environ.get('JWT_SECRET') or '').strip()


def auth_enabled():
    return bool(jwt_secret())


def google_client_id():
    return (
        os.environ.get('GOOGLE_CLIENT_ID')
        or os.environ.get('FOLIO_GOOGLE_CLIENT_ID')
        or ''
    ).strip()


def _b64url(raw):
    if isinstance(raw, str):
        raw = raw.encode('utf-8')
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64url_decode(value):
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000).hex()
    return f'pbkdf2${salt}${digest}'


def verify_password(password, stored):
    try:
        kind, salt, digest = (stored or '').split('$', 2)
    except ValueError:
        return False
    if kind != 'pbkdf2':
        return False
    check = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000).hex()
    return secrets.compare_digest(check, digest)


def sign_token(user):
    secret = jwt_secret()
    if not secret:
        raise RuntimeError('FOLIO_JWT_SECRET is not set')
    payload = {
        'sub': user['id'],
        'username': user.get('username') or '',
        'exp': int(time.time()) + TOKEN_HOURS * 3600,
    }
    header = _b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')))
    body = _b64url(json.dumps(payload, separators=(',', ':')))
    sig = hmac.new(secret.encode('utf-8'), f'{header}.{body}'.encode('utf-8'), hashlib.sha256).digest()
    return f'{header}.{body}.{_b64url(sig)}'


def decode_token(token):
    secret = jwt_secret()
    if not secret or not token:
        return None
    parts = token.split('.')
    if len(parts) != 3:
        return None
    header, body, signature = parts
    expected = hmac.new(secret.encode('utf-8'), f'{header}.{body}'.encode('utf-8'), hashlib.sha256).digest()
    try:
        given = _b64url_decode(signature)
    except Exception:
        return None
    if not hmac.compare_digest(expected, given):
        return None
    try:
        payload = json.loads(_b64url_decode(body))
    except Exception:
        return None
    if int(payload.get('exp') or 0) < int(time.time()):
        return None
    return payload


def _headers(event):
    return {str(key).lower(): value for key, value in (event.get('headers') or {}).items()}


def bearer_token(event):
    header = _headers(event).get('authorization') or ''
    if header.lower().startswith('bearer '):
        return header.split(' ', 1)[1].strip()
    return ''


def cookie_token(event):
    raw = _headers(event).get('cookie') or ''
    for part in raw.split(';'):
        name, _, value = part.strip().partition('=')
        if name == COOKIE_NAME:
            return urllib.parse.unquote(value.strip())
    return ''


def session_token(event):
    """Prefer a valid Bearer token, but fall back to the HttpOnly cookie.

    A stale localStorage Bearer used to shadow a still-valid folio_session
    cookie and cause refresh flashes (login UI → auto-login a few seconds later).
    """
    bearer = bearer_token(event)
    cookie = cookie_token(event)
    if bearer and decode_token(bearer):
        return bearer
    if cookie and decode_token(cookie):
        return cookie
    return bearer or cookie


def _uses_https(event):
    headers = _headers(event)
    proto = (headers.get('x-forwarded-proto') or '').split(',')[0].strip().lower()
    if proto == 'https':
        return True
    origin = headers.get('origin') or ''
    return origin.startswith('https://')


def session_cookie_header(token, event, clear=False):
    max_age = 0 if clear else TOKEN_HOURS * 3600
    value = 'deleted' if clear else urllib.parse.quote(token or '', safe='')
    parts = [
        f'{COOKIE_NAME}={value}',
        'Path=/',
        f'Max-Age={max_age}',
        'HttpOnly',
        'SameSite=Lax',
    ]
    if clear:
        parts.append('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    if _uses_https(event):
        parts.append('Secure')
    return '; '.join(parts)


def with_session_cookie(headers, token, event, clear=False):
    out = dict(headers or {})
    out['Set-Cookie'] = session_cookie_header(token, event, clear=clear)
    return out


def identity_from_event(event, body=None, params=None):
    payload = decode_token(session_token(event))
    if payload and payload.get('sub'):
        return payload['sub'], None
    if auth_enabled():
        return None, 'Please sign in'
    body = body or {}
    params = params or event.get('queryStringParameters') or {}
    user_id = (body.get('userId') or params.get('userId') or '').strip()
    if not user_id:
        return None, 'Please sign in'
    return user_id, None


def public_user(user):
    created = user.get('created_at') or user.get('createdAt') or ''
    if hasattr(created, 'isoformat'):
        created = created.isoformat()
    return {
        'id': user.get('id'),
        'username': user.get('username'),
        'email': user.get('email') or '',
        'createdAt': created,
    }


def _json_body(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return None
    return body if isinstance(body, dict) else None


def _google_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {}, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
            return payload if isinstance(payload, dict) else None
    except urllib.error.HTTPError as err:
        logger.warning('Google auth HTTP %s for %s', err.code, url.split('?', 1)[0])
        return None
    except Exception as err:
        logger.warning('Google auth request failed: %s', err)
        return None


def _audience_matches(info, client_id):
    if not info or not client_id:
        return False
    aud = info.get('aud')
    audiences = aud if isinstance(aud, list) else [aud]
    return client_id in audiences or info.get('azp') == client_id


def _email_verified(info):
    value = info.get('email_verified')
    return value is True or str(value).lower() in ('true', '1')


def verify_google_id_token(credential):
    token = (credential or '').strip()
    client_id = google_client_id()
    if not token or token.count('.') != 2 or not client_id:
        return None, 'Google sign-in failed'
    url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': token})
    info = _google_json(url)
    if not info:
        return None, 'Google sign-in failed'
    if not _audience_matches(info, client_id):
        return None, 'Google sign-in failed'
    if info.get('iss') not in GOOGLE_ISSUERS:
        return None, 'Google sign-in failed'
    if int(info.get('exp') or 0) < int(time.time()):
        return None, 'Google sign-in expired. Try again'
    if not info.get('sub'):
        return None, 'Google sign-in failed'
    return info, None


def verify_google_access_token(access_token):
    token = (access_token or '').strip()
    client_id = google_client_id()
    if not token or not client_id:
        return None, 'Google sign-in failed'
    info = _google_json(
        'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'access_token': token})
    )
    if not info or not _audience_matches(info, client_id):
        return None, 'Google sign-in failed'
    if int(info.get('exp') or 0) and int(info.get('exp') or 0) < int(time.time()):
        return None, 'Google sign-in expired. Try again'
    profile = _google_json(
        'https://www.googleapis.com/oauth2/v3/userinfo',
        headers={'Authorization': f'Bearer {token}'},
    )
    if not profile or not profile.get('sub'):
        return None, 'Google sign-in failed'
    if info.get('sub') and info.get('sub') != profile.get('sub'):
        return None, 'Google sign-in failed'
    return profile, None


def _username_seed(email, name):
    local = (email or '').split('@')[0]
    raw = local or name or 'user'
    cleaned = re.sub(r'[^a-zA-Z0-9._-]', '', raw).strip('._-')
    if len(cleaned) < 3:
        cleaned = f'user{cleaned}'
    return (cleaned or 'user')[:32]


def allocate_username(store, email, name):
    base = _username_seed(email, name)
    if USERNAME_RE.match(base) and not store.get_user_by_username(base):
        return base
    for index in range(2, 10000):
        suffix = str(index)
        candidate = f'{base[:32 - len(suffix)]}{suffix}'
        if USERNAME_RE.match(candidate) and not store.get_user_by_username(candidate):
            return candidate
    return f'user{uuid.uuid4().hex[:12]}'


def login_or_register_google(credential=None, access_token=None):
    if not google_client_id():
        return None, 'Google sign-in is not configured'
    if credential:
        info, err = verify_google_id_token(credential)
    elif access_token:
        info, err = verify_google_access_token(access_token)
    else:
        return None, 'Google sign-in failed'
    if err:
        return None, err

    google_sub = (info.get('sub') or '').strip()
    email = (info.get('email') or '').strip().lower()
    name = (info.get('name') or '').strip()
    store = get_store()

    user = store.get_user_by_google_sub(google_sub)
    if user:
        updates = {}
        if email and not (user.get('email') or '').strip():
            updates['email'] = email
        if updates:
            user = store.update_user(user['id'], updates) or user
        return user, None

    if email and _email_verified(info):
        existing = store.get_user_by_email(email)
        if existing:
            existing_sub = (existing.get('google_sub') or '').strip()
            if existing_sub and existing_sub != google_sub:
                return None, 'That Google account cannot be used'
            user = store.update_user(existing['id'], {'google_sub': google_sub, 'email': email})
            return user or existing, None

    user = {
        'id': str(uuid.uuid4()),
        'username': allocate_username(store, email, name),
        'password_hash': None,
        'google_sub': google_sub,
        'email': email,
    }
    store.create_user(user)
    return user, None


def _validate_credentials(username, password, creating=False):
    name = (username or '').strip()
    secret = password or ''
    if not USERNAME_RE.match(name):
        return None, 'Username must be 3-32 letters, numbers, dots, dashes, or underscores'
    if len(secret) < 6:
        return None, 'Password must be at least 6 characters'
    if creating and len(secret) > 128:
        return None, 'Password is too long'
    return name, None


def register_user(username, password):
    name, err = _validate_credentials(username, password, creating=True)
    if err:
        return None, err
    store = get_store()
    if store.get_user_by_username(name):
        return None, 'That username is already taken'
    user = {
        'id': str(uuid.uuid4()),
        'username': name,
        'password_hash': hash_password(password),
    }
    store.create_user(user)
    return user, None


def login_user(username, password):
    name, err = _validate_credentials(username, password)
    if err:
        return None, 'Check your username and password'
    store = get_store()
    user = store.get_user_by_username(name)
    if not user or not verify_password(password, user.get('password_hash') or ''):
        return None, 'Check your username and password'
    return user, None


def _token_response(user, cors_headers, event):
    token = sign_token(user)
    return {
        'statusCode': 200,
        'body': json.dumps({'token': token, 'user': public_user(user)}),
        'headers': with_session_cookie(cors_headers, token, event),
    }


def _error_response(status, message, cors_headers):
    return {
        'statusCode': status,
        'body': json.dumps({'error': message}),
        'headers': cors_headers,
    }


def handle_auth(event, path, method, cors_headers):
    if method == 'OPTIONS':
        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'CORS preflight'}),
            'headers': cors_headers,
        }
    if path == '/auth/config' and method == 'GET':
        return {
            'statusCode': 200,
            'body': json.dumps({
                'auth': auth_enabled(),
                'googleClientId': google_client_id(),
            }),
            'headers': cors_headers,
        }
    if not auth_enabled():
        return _error_response(503, 'Auth is not configured', cors_headers)
    try:
        if path == '/auth/register' and method == 'POST':
            body = _json_body(event)
            if body is None:
                return _error_response(400, 'Invalid request', cors_headers)
            user, err = register_user(body.get('username'), body.get('password'))
            if err:
                return _error_response(400, err, cors_headers)
            return _token_response(user, cors_headers, event)
        if path == '/auth/login' and method == 'POST':
            body = _json_body(event)
            if body is None:
                return _error_response(400, 'Invalid request', cors_headers)
            user, err = login_user(body.get('username'), body.get('password'))
            if err:
                return _error_response(401, err, cors_headers)
            return _token_response(user, cors_headers, event)
        if path == '/auth/google' and method == 'POST':
            body = _json_body(event)
            if body is None:
                return _error_response(400, 'Invalid request', cors_headers)
            user, err = login_or_register_google(
                credential=body.get('credential'),
                access_token=body.get('accessToken') or body.get('access_token'),
            )
            if err:
                status = 503 if 'not configured' in err else 401
                return _error_response(status, err, cors_headers)
            return _token_response(user, cors_headers, event)
        if path == '/auth/logout' and method == 'POST':
            return {
                'statusCode': 200,
                'body': json.dumps({'ok': True}),
                'headers': with_session_cookie(cors_headers, '', event, clear=True),
            }
        if path == '/auth/me' and method == 'GET':
            payload = decode_token(session_token(event))
            if not payload:
                return _error_response(401, 'Please sign in', cors_headers)
            user = get_store().get_user_by_id(payload.get('sub'))
            if not user:
                return _error_response(401, 'Please sign in', cors_headers)
            token = sign_token(user)
            return {
                'statusCode': 200,
                'body': json.dumps({'user': public_user(user), 'token': token}),
                'headers': with_session_cookie(cors_headers, token, event),
            }
        return _error_response(404, 'Not Found', cors_headers)
    except Exception as err:
        logger.error('Auth error: %s', err)
        return _error_response(500, 'Auth failed', cors_headers)
