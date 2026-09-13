import json
import os
import re
import uuid
import base64
import logging
import urllib.error
import urllib.request
from pathlib import Path
from openai import OpenAI
from datetime import datetime, timezone

try:
    import boto3
except ImportError:
    boto3 = None

from auth import auth_enabled, handle_auth, identity_from_event, google_client_id
from store import get_store, storage_kind

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()


def load_local_env():
    root = Path(__file__).resolve().parent.parent
    for name in ('.env', '.env.local'):
        env_path = root / name
        if not env_path.is_file():
            continue
        try:
            for raw in env_path.read_text(encoding='utf-8').splitlines():
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key or not value:
                    continue
                os.environ.setdefault(key, value)
                os.environ.setdefault(key.upper(), value)
        except Exception as err:
            logger.warning('Could not load %s: %s', name, err)


def env_any(*names):
    for name in names:
        value = (os.environ.get(name) or '').strip()
        if value and value != 'missing':
            return value
    return ''


load_local_env()

DYNAMODB_TABLE_NAME = os.environ.get('DYNAMODB_TABLE_NAME')
BACKEND_BUCKET_NAME = os.environ.get('BACKEND_BUCKET_NAME')
REGION = os.environ.get('AWS_REGION') or os.environ.get('REGION') or 'ap-southeast-1'
USE_AWS = bool(boto3 and DYNAMODB_TABLE_NAME)

# Set OpenAI API key for DeepSeek
client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY') or 'missing',
    base_url=os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
)

openrouter_client = None
if env_any('OPENROUTER_API_KEY', 'openrouter_api_key'):
    openrouter_client = OpenAI(
        api_key=env_any('OPENROUTER_API_KEY', 'openrouter_api_key'),
        base_url=os.environ.get('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
        default_headers={
            'HTTP-Referer': os.environ.get(
                'OPENROUTER_SITE_URL',
                'https://folio-althafhasan03-2812s-projects.vercel.app',
            ),
            'X-Title': 'Folio',
        },
    )

textract = None
s3_client = None
table = get_store()

if USE_AWS:
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    textract = boto3.client('textract', region_name=REGION)
    s3_client = boto3.client('s3', region_name=REGION)

    class DynamoTable:
        def __init__(self, inner):
            self.inner = inner

        def get_item(self, user_id, card_id):
            response = self.inner.get_item(Key={'userId': user_id, 'cardId': card_id})
            return response.get('Item')

        def put_item(self, item):
            self.inner.put_item(Item=item)

        def delete_item(self, user_id, card_id):
            self.inner.delete_item(Key={'userId': user_id, 'cardId': card_id})

        def query_by_user(self, user_id):
            response = self.inner.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key('userId').eq(user_id)
            )
            return response.get('Items', [])

    table = DynamoTable(dynamodb.Table(DYNAMODB_TABLE_NAME))

PROFILE_CARD_ID = '__PROFILE__'
SLUG_ALIAS_CARD_ID = 'ALIAS'
MAX_AVATAR_CHARS = 280000

PROFILE_FIELDS = (
    'name', 'title', 'company', 'email', 'phone', 'website', 'linkedin',
    'twitter', 'instagram', 'github', 'address', 'bio', 'avatar', 'theme',
    'accent', 'layout', 'slug', 'qrMode'
)


def is_profile_record(item):
    if not item:
        return False
    return item.get('cardId') == PROFILE_CARD_ID or item.get('kind') in ('profile', 'slug-alias')


def sanitize_slug(value):
    raw = (value or '').strip().lower().replace(' ', '-')
    slug = re.sub(r'[^a-z0-9-]', '', raw)
    slug = re.sub(r'-{2,}', '-', slug).strip('-')
    return slug[:40]


def parse_json_body(event):
    body = event.get('body') or '{}'
    if event.get('isBase64Encoded'):
        body = base64.b64decode(body).decode('utf-8')
    return json.loads(body)


def vcard_escape(value):
    if value is None:
        return ''
    return (
        str(value)
        .replace('\\', '\\\\')
        .replace('\r\n', '\\n')
        .replace('\n', '\\n')
        .replace('\r', '\\n')
        .replace(';', '\\;')
        .replace(',', '\\,')
    )


def split_person_name(full_name):
    parts = [p for p in (full_name or '').strip().split() if p]
    if not parts:
        return '', ''
    if len(parts) == 1:
        return parts[0], ''
    return ' '.join(parts[:-1]), parts[-1]


def fold_vcard_line(line):
    if len(line) <= 75:
        return line
    chunks = [line[:75]]
    rest = line[75:]
    while rest:
        chunks.append(' ' + rest[:74])
        rest = rest[74:]
    return '\r\n'.join(chunks)


def normalize_url(url):
    value = (url or '').strip()
    if not value:
        return ''
    if value.startswith(('http://', 'https://', 'mailto:', 'tel:')):
        return value
    return f'https://{value}'


def build_vcard(data, version='3.0'):
    """Build a vCard 3.0 or 4.0 document (CRLF, RFC 2426 / 6350)."""
    version = '4.0' if str(version) == '4.0' else '3.0'
    name = (data.get('name') or '').strip()
    first, last = split_person_name(name)
    email = (data.get('email') or '').strip()
    phone = (data.get('phone') or '').strip()
    company = (data.get('company') or '').strip()
    title = (data.get('title') or '').strip()
    website = normalize_url(data.get('website'))
    address = (data.get('address') or '').strip()
    bio = (data.get('bio') or data.get('notes') or '').strip()
    avatar = (data.get('avatar') or data.get('avatarUrl') or '').strip()
    profile_url = (data.get('profileUrl') or '').strip()

    lines = ['BEGIN:VCARD', f'VERSION:{version}']
    if name:
        lines.append(f'N:{vcard_escape(last)};{vcard_escape(first)};;;')
        lines.append(f'FN:{vcard_escape(name)}')
    if company:
        lines.append(f'ORG:{vcard_escape(company)}')
    if title:
        lines.append(f'TITLE:{vcard_escape(title)}')
    if email:
        lines.append(f'EMAIL;TYPE=WORK:{vcard_escape(email)}' if version == '3.0' else f'EMAIL;TYPE=work:{email}')
    if phone:
        lines.append(f'TEL;TYPE=CELL,VOICE:{vcard_escape(phone)}' if version == '3.0' else f'TEL;TYPE=cell,voice:{phone}')
    if address:
        lines.append(f'ADR;TYPE=WORK:;;{vcard_escape(address)};;;' if version == '3.0' else f'ADR;TYPE=work:;;{vcard_escape(address)};;;')
    if website:
        lines.append(f'URL:{vcard_escape(website)}')
    if profile_url:
        lines.append(f'URL:{vcard_escape(profile_url)}')

    socials = (
        ('linkedin', data.get('linkedin')),
        ('twitter', data.get('twitter')),
        ('instagram', data.get('instagram')),
        ('github', data.get('github')),
    )
    for label, raw in socials:
        href = normalize_url(raw)
        if href:
            lines.append(f'URL;TYPE={label}:{vcard_escape(href)}')

    if avatar.startswith('http://') or avatar.startswith('https://'):
        lines.append(f'PHOTO;VALUE=URI:{avatar}')
    if bio:
        lines.append(f'NOTE:{vcard_escape(bio)}')
    lines.append(f'REV:{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}')
    lines.append('END:VCARD')
    return '\r\n'.join(fold_vcard_line(line) for line in lines)


def vcard_filename(data):
    name = re.sub(r'[^\w.-]+', '_', (data.get('name') or 'contact').strip()) or 'contact'
    return f'{name}.vcf'


def vcard_response(data, cors_headers, version='3.0'):
    content = build_vcard(data, version=version)
    filename = vcard_filename(data)
    return {
        'statusCode': 200,
        'headers': {
            **cors_headers,
            'Content-Type': 'text/vcard; charset=utf-8',
            'Content-Disposition': f'attachment; filename="{filename}"'
        },
        'body': content
    }


def public_profile_payload(item):
    payload = {key: item.get(key, '') for key in PROFILE_FIELDS}
    payload['cardId'] = PROFILE_CARD_ID
    payload['kind'] = 'profile'
    return payload


def lookup_profile(slug_or_user):
    slug = (slug_or_user or '').strip()
    if not slug:
        return None
    direct = table.get_item(slug, PROFILE_CARD_ID)
    if direct:
        return direct
    alias = table.get_item(f'slug:{sanitize_slug(slug)}', SLUG_ALIAS_CARD_ID)
    if not alias:
        return None
    owner_id = alias.get('ownerUserId')
    if not owner_id:
        return None
    return table.get_item(owner_id, PROFILE_CARD_ID)


def lambda_handler(event, context):
    """Main Lambda handler function."""
    http_method = event['httpMethod']
    path = event['path']
    logger.info(f"Handling request: {http_method} {path}")
    
    # Base CORS headers
    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
        'Content-Type': 'application/json'
    }

    if path.startswith('/auth/'):
        return handle_auth(event, path, http_method, cors_headers)
    if path == '/scan' and http_method == 'POST':
        return scan_business_card(event, context, cors_headers)
    elif path == '/network' and http_method == 'GET':
        return get_network_analysis(event, cors_headers)
    elif path == '/contacts' and http_method == 'GET':
        return get_contacts(event, cors_headers)
    elif path == '/contacts' and http_method == 'DELETE':
        return delete_all_contacts(event, cors_headers)
    elif path.startswith('/contacts/') and http_method == 'DELETE':
        return delete_contact(event, cors_headers)
    elif path.startswith('/contacts/') and http_method == 'PUT':
        return update_contact(event, cors_headers)
    elif path.startswith('/images/') and http_method == 'GET':
        return get_image(event, cors_headers)
    elif path == '/vcard' and http_method == 'POST':
        return generate_vcard_from_body(event, cors_headers)
    elif path.startswith('/vcard/profile/') and http_method == 'GET':
        return get_profile_vcard(event, cors_headers)
    elif path.startswith('/vcard/') and http_method == 'GET':
        return get_vcard(event, cors_headers)
    elif path == '/profile' and http_method == 'GET':
        return get_own_profile(event, cors_headers)
    elif path == '/profile' and http_method == 'PUT':
        return save_profile(event, cors_headers)
    elif path.startswith('/profile/') and http_method == 'GET':
        return get_public_profile(event, cors_headers)
    elif path == '/chat' and http_method == 'POST':
        return handle_chat_message(event, cors_headers)
    elif path in ('/health', '/api/health') and http_method == 'GET':
        return {
            'statusCode': 200,
            'body': json.dumps({
                'ok': True,
                'service': 'folio',
                'vision': bool(env_any('OPENROUTER_API_KEY', 'openrouter_api_key', 'GEMINI_API_KEY')),
                'parser': bool(env_any('OPENROUTER_API_KEY', 'openrouter_api_key', 'DEEPSEEK_API_KEY')),
                'db': storage_kind(),
                'images': 'postgres' if storage_kind() == 'postgres' else ('s3' if (s3_client and BACKEND_BUCKET_NAME) else 'store'),
                'auth': auth_enabled(),
                'google': bool(google_client_id()),
            }),
            'headers': cors_headers
        }
    elif http_method == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': json.dumps({'message': 'CORS preflight'})
        }
    else:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Not Found'}),
            'headers': cors_headers
        }

def require_user(event, cors_headers, body=None, params=None):
    user_id, err = identity_from_event(event, body=body, params=params)
    if err:
        return None, {
            'statusCode': 401,
            'body': json.dumps({'error': err}),
            'headers': cors_headers,
        }
    return user_id, None


def persist_scanned_contact(image_bytes_list, raw_texts, user_id):
    sides = [img for img in image_bytes_list if img]
    if not sides:
        raise KeyError("No images provided")
    client_parts = []
    for index, _image in enumerate(sides):
        label = 'FRONT' if index == 0 else 'BACK'
        text = raw_texts[index] if index < len(raw_texts) else ''
        if len(sides) > 1:
            client_parts.append(f'{label}\n{text}'.strip())
        elif text:
            client_parts.append(text)
    client_text = '\n\n'.join(client_parts)

    extra = sides[1:] if len(sides) > 1 else None
    vision_data, raw_text = extract_card_text_sources(sides[0], client_text, extra)
    if len(sides) > 1 and raw_text and 'FRONT' not in raw_text.upper():
        raw_text = 'FRONT AND BACK OF THE SAME BUSINESS CARD:\n' + raw_text

    parsed = parse_with_deepseek(raw_text)
    card_data = merge_card_dicts(vision_data, parsed, parse_card_text_locally(raw_text))
    if not card_data_filled(card_data) and not (raw_text or '').strip():
        card_data['notes'] = 'Could not read text automatically. Please edit this contact.'

    card_id = str(uuid.uuid4())
    card_data['userId'] = user_id
    card_data['cardId'] = card_id
    card_data['dateAdded'] = datetime.now().isoformat()
    card_data['sides'] = len(sides)
    card_data['imageUrl'] = upload_image_to_s3(sides[0], card_id, user_id, 'front')
    if len(sides) > 1:
        card_data['backImageUrl'] = upload_image_to_s3(sides[1], card_id, user_id, 'back')
    card_data.setdefault('notes', '')
    card_data.setdefault('tags', [])
    card_data.setdefault('followUpDate', '')
    table.put_item(card_data)
    return public_scan_card(card_data)


def scan_business_card(event, context, cors_headers):
    try:
        body = json.loads(event['body'])
        user_id, auth_error = require_user(event, cors_headers, body=body)
        if auth_error:
            return auth_error
        images = body.get('images', [])
        raw_texts = body.get('rawTexts') or body.get('raw_texts') or []
        two_sided = bool(body.get('twoSided') or body.get('two_sided'))

        if not images:
            image_base64 = body.get('image')
            if not image_base64:
                raise KeyError("No images provided")
            images = [image_base64]
        if not raw_texts and body.get('rawText'):
            raw_texts = [body.get('rawText')]

        decoded = [decode_image_payload(image) for image in images]
        if two_sided:
            groups = [list(zip(decoded[:2], (raw_texts + ['', ''])[:2]))]
        else:
            groups = [[(image, raw_texts[index] if index < len(raw_texts) else '')] for index, image in enumerate(decoded)]

        results = []
        for group in groups:
            side_images = [item[0] for item in group]
            side_texts = [item[1] for item in group]
            results.append(persist_scanned_contact(side_images, side_texts, user_id))

        return {
            'statusCode': 200,
            'body': json.dumps({'contacts': results}),
            'headers': cors_headers
        }
    except KeyError as e:
        logger.error(f"KeyError: {str(e)}")
        return {
            'statusCode': 400,
            'body': json.dumps({'error': f'Missing key: {str(e)}'}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def extract_raw_text(textract_response):
    text_blocks = [block['Text'] for block in textract_response['Blocks'] if block['BlockType'] == 'LINE']
    return '\n'.join(text_blocks)


INDUSTRY_OPTIONS = (
    'Technology, Healthcare, Finance, Manufacturing, Retail, Education, '
    'Government, Non-Profit, Media, Transportation, Energy, Agriculture, '
    'Construction, Hospitality, Legal, Consulting, Real Estate, Telecommunications, Other'
)
EMAIL_RE = re.compile(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}', re.I)
URL_RE = re.compile(r'(https?://[^\s]+|www\.[^\s]+)', re.I)
PHONE_RE = re.compile(r'(?:\+|00)?\d[\d \t().\-/]{6,}\d')
CARD_FIELD_KEYS = (
    'name', 'company', 'department', 'title', 'email', 'phone', 'address', 'website', 'industry'
)


def decode_image_payload(image_base64):
    if not image_base64:
        return b''
    raw = str(image_base64)
    if ',' in raw and raw.lstrip().startswith('data:'):
        raw = raw.split(',', 1)[1]
    return base64.b64decode(raw)


def strip_json_fence(text):
    cleaned = (text or '').strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned, flags=re.I)
    cleaned = re.sub(r'\s*```$', '', cleaned)
    match = re.search(r'\{[\s\S]*\}', cleaned)
    return match.group(0) if match else cleaned


def ocr_quality_score(text):
    value = (text or '').strip()
    if not value:
        return -1
    emails = len(EMAIL_RE.findall(value))
    phones = len(PHONE_RE.findall(value))
    urls = len(URL_RE.findall(value))
    alnum = sum(ch.isalnum() for ch in value)
    if alnum < 6:
        return 0
    words = [w for w in re.split(r'\s+', value) if w]
    garbage = 1 - (alnum / max(len(value), 1))
    return emails * 10 + phones * 6 + urls * 4 + min(len(words), 50) * 0.35 - garbage * 12


def card_data_filled(data):
    if not data:
        return False
    return any(str(data.get(key) or '').strip() for key in ('name', 'company', 'title', 'email', 'phone', 'website'))


def merge_ocr_texts(*texts):
    seen = set()
    lines = []
    for text in texts:
        for line in (text or '').splitlines():
            normalized = re.sub(r'\s+', ' ', line).strip()
            key = normalized.lower()
            if not normalized or key in seen:
                continue
            seen.add(key)
            lines.append(normalized)
    return '\n'.join(lines)


def merge_card_dicts(*sources):
    merged = empty_card_data()
    for source in sources:
        if not source:
            continue
        for key in CARD_FIELD_KEYS:
            current = merged.get(key)
            incoming = source.get(key)
            if key == 'industry':
                if incoming and incoming != 'Other' and (not current or current == 'Other'):
                    merged[key] = incoming
                continue
            if (not current) and incoming not in (None, '', []):
                merged[key] = incoming
            elif key == 'phone' and incoming and current and str(incoming) not in str(current):
                left_digits = re.sub(r'\D', '', str(current))
                right_digits = re.sub(r'\D', '', str(incoming))
                if right_digits and right_digits not in left_digits:
                    merged[key] = f'{current} / {incoming}'
    return merged


def public_scan_card(card_data):
    return contact_for_client(card_data)


def contact_for_client(card_data):
    """Return contact metadata only — never embed image bytes in API payloads."""
    if not card_data:
        return card_data
    public_card = dict(card_data)
    for key in (
        'frontImage', 'backImage', 'originalImageUrl', 'originalBackImageUrl',
        'cachedImageUrl', 'imageDataUrl',
    ):
        public_card.pop(key, None)

    card_id = public_card.get('cardId')
    user_id = public_card.get('userId')
    front_ref = str(public_card.get('imageUrl') or '')
    back_ref = str(public_card.get('backImageUrl') or '')

    has_front = bool(front_ref) and not front_ref.startswith('data:')
    has_back = bool(back_ref) and not back_ref.startswith('data:')
    if front_ref.startswith('data:'):
        has_front = True
    if back_ref.startswith('data:'):
        has_back = True
    if not has_front and user_id and card_id and hasattr(table, 'has_card_image'):
        try:
            has_front = bool(table.has_card_image(user_id, card_id, 'front'))
        except Exception:
            has_front = False
    if not has_back and user_id and card_id and hasattr(table, 'has_card_image'):
        try:
            has_back = bool(table.has_card_image(user_id, card_id, 'back'))
        except Exception:
            has_back = False

    public_card['imageUrl'] = 'db:front' if has_front else ''
    if has_back:
        public_card['backImageUrl'] = 'db:back'
    else:
        public_card.pop('backImageUrl', None)

    public_card['hasImage'] = bool(has_front)
    public_card['hasBackImage'] = bool(has_back)
    return public_card


def extract_text_with_textract(image_bytes):
    if not textract or not image_bytes:
        return ''
    try:
        response = textract.detect_document_text(Document={'Bytes': image_bytes})
        return extract_raw_text(response)
    except Exception as err:
        logger.warning('Textract OCR failed: %s', err)
        return ''


def gemini_generate(parts, models=None):
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return ''
    preferred = os.environ.get('GEMINI_MODEL') or 'gemini-2.0-flash'
    candidates = models or [preferred, 'gemini-2.5-flash', 'gemini-2.0-flash-lite']
    seen = []
    for model in candidates:
        if not model or model in seen:
            continue
        seen.append(model)
        payload = json.dumps({'contents': [{'parts': parts}]}).encode('utf-8')
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}'
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=50) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            text_parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
            return '\n'.join(part.get('text', '') for part in text_parts).strip()
        except urllib.error.HTTPError as err:
            logger.warning('Gemini %s failed: %s', model, err.read().decode('utf-8', errors='ignore'))
        except Exception as err:
            logger.warning('Gemini %s failed: %s', model, err)
    return ''


def gemini_image_parts(image_bytes_list):
    parts = []
    for image_bytes in image_bytes_list or []:
        if not image_bytes:
            continue
        parts.append({
            'inline_data': {
                'mime_type': 'image/jpeg',
                'data': base64.b64encode(image_bytes).decode('utf-8'),
            }
        })
    return parts


def parse_model_card_json(text):
    parsed = {}
    raw_text = text or ''
    try:
        payload = json.loads(strip_json_fence(text))
        if isinstance(payload, dict):
            parsed = {key: payload.get(key, '') for key in CARD_FIELD_KEYS}
            raw_text = payload.get('rawText') or text
    except Exception:
        parsed = {}
    return parsed, (raw_text or '').strip()


def card_vision_prompt(image_count):
    sides_note = (
        'These photos are the FRONT then BACK of the same business card. Read both sides.'
        if image_count > 1 else
        'Read every visible character on this business card.'
    )
    return (
        f'{sides_note} Extract contact details even if they are small, rotated, on a dark background, '
        'white-on-black, glossy, or split across sides. Read digits carefully: do not swap 8/0/9 or +91/+01. '
        'Keep Indian mobiles as +91 followed by 10 digits. Keep the full address including PIN code and landmark. '
        'Return JSON only with keys: '
        'name, company, department, title, email, phone, address, website, industry, rawText. '
        'phone may include multiple numbers separated by " / ". '
        f'industry must be one of: {INDUSTRY_OPTIONS}. '
        'rawText must contain all readable text, with FRONT/BACK labels when both sides are present. '
        'Leave unknown keys empty. Do not invent details.'
    )


def extract_card_with_openrouter(image_bytes_list):
    images = [img for img in (image_bytes_list or []) if img]
    if not openrouter_client or not images:
        return {}, ''
    prompt = card_vision_prompt(len(images))
    content = [{'type': 'text', 'text': prompt}]
    for image_bytes in images:
        encoded = base64.b64encode(image_bytes).decode('utf-8')
        content.append({
            'type': 'image_url',
            'image_url': {'url': f'data:image/jpeg;base64,{encoded}'},
        })
    preferred = os.environ.get('OPENROUTER_VISION_MODEL') or 'google/gemini-2.5-flash'
    candidates = [
        preferred,
        'google/gemini-2.0-flash-001',
        'openai/gpt-4o-mini',
        'qwen/qwen2.5-vl-32b-instruct',
    ]
    seen = []
    for model in candidates:
        if not model or model in seen:
            continue
        seen.append(model)
        try:
            completion = openrouter_client.chat.completions.create(
                model=model,
                messages=[{'role': 'user', 'content': content}],
                temperature=0,
                max_tokens=1200,
            )
            text = (completion.choices[0].message.content or '').strip()
            if text:
                logger.info('OpenRouter vision used model %s', model)
                return parse_model_card_json(text)
        except Exception as err:
            logger.warning('OpenRouter vision %s failed: %s', model, err)
    return {}, ''


def extract_card_with_gemini(image_bytes_list):
    images = [img for img in (image_bytes_list or []) if img]
    if not images:
        return {}, ''
    text = gemini_generate([{'text': card_vision_prompt(len(images))}, *gemini_image_parts(images)])
    return parse_model_card_json(text)


def extract_text_with_gemini(image_bytes):
    _parsed, text = extract_card_with_gemini([image_bytes] if image_bytes else [])
    return text


def extract_card_text_sources(image_bytes, client_text='', extra_images=None):
    images = [image_bytes, *(extra_images or [])]
    vision_data, vision_text = extract_card_with_openrouter(images)
    if not card_data_filled(vision_data) and not (vision_text or '').strip():
        vision_data, vision_text = extract_card_with_gemini(images)
    textract_texts = [extract_text_with_textract(image) for image in images if image]
    merged = merge_ocr_texts(vision_text, *textract_texts, client_text)
    if ocr_quality_score(merged) < 0:
        logger.warning('No server OCR available; continuing with client text only')
        return vision_data, (client_text or '').strip()
    return vision_data, merged


def empty_card_data():
    return {
        'name': '',
        'company': '',
        'department': '',
        'title': '',
        'email': '',
        'phone': '',
        'address': '',
        'website': '',
        'industry': 'Other',
        'notes': '',
        'tags': [],
        'followUpDate': '',
    }


def parse_card_text_locally(raw_text):
    """Best-effort field extraction when DeepSeek is unavailable."""
    data = empty_card_data()
    text = raw_text or ''
    if not text.strip():
        data['notes'] = 'Could not read text automatically. Please edit this contact.'
        return data

    emails = EMAIL_RE.findall(text)
    if emails:
        data['email'] = emails[0]

    for match in URL_RE.findall(text):
        candidate = match.rstrip('.,;)')
        if '@' in candidate:
            continue
        data['website'] = candidate
        break

    phones = []
    seen_digits = set()
    for match in PHONE_RE.findall(text):
        cleaned = re.sub(r'\s+', ' ', match).strip(' .-')
        digits = re.sub(r'\D', '', cleaned)
        if len(digits) < 8 or len(digits) > 15 or digits in seen_digits:
            continue
        seen_digits.add(digits)
        phones.append(cleaned)
    if phones:
        data['phone'] = ' / '.join(phones[:3])

    skip = {
        data['email'].lower(),
        data['website'].lower(),
        *(phone.lower() for phone in phones),
        *(re.sub(r'\s+', '', phone) for phone in phones),
        'front', 'back',
    }
    leftover = []
    for line in text.splitlines():
        stripped = re.sub(r'\s+', ' ', line).strip(' -:|')
        if not stripped or stripped.lower() in skip or '@' in stripped:
            continue
        if URL_RE.search(stripped) or PHONE_RE.search(stripped):
            continue
        letters = sum(ch.isalpha() for ch in stripped)
        if letters < 2:
            continue
        leftover.append(stripped[:80])

    company_hint = re.compile(r'\b(inc|ltd|llc|pvt|gmbh|corp|co|company|group|studio|labs?|technologies|solutions)\b', re.I)
    if leftover:
        company_line = next((line for line in leftover if company_hint.search(line)), '')
        name_line = leftover[0]
        if company_line and name_line == company_line and len(leftover) > 1:
            name_line = leftover[1]
        data['name'] = name_line[:80]
        if company_line:
            data['company'] = company_line[:80]
        elif len(leftover) > 1:
            data['company'] = leftover[1][:80]
        title_line = next((line for line in leftover if line not in (data['name'], data['company'])), '')
        if title_line:
            data['title'] = title_line[:80]
        address_hint = re.compile(r'\b(rd|road|st|street|ave|avenue|lane|blvd|po box|city|floor)\b', re.I)
        address_line = next((line for line in leftover if address_hint.search(line) or re.search(r'\d{1,5}\s+[A-Za-z]', line)), '')
        if address_line and address_line not in (data['name'], data['company'], data['title']):
            data['address'] = address_line[:160]
    return data


def extract_card_text(image_bytes, client_text='', extra_images=None):
    vision_data, merged = extract_card_text_sources(image_bytes, client_text, extra_images)
    return merged or (client_text or '').strip()

def parse_with_deepseek(raw_text):
    prompt = (
        "Extract the following information from the provided business card text. "
        "The text may include FRONT and BACK sides of the same card — merge both sides into one contact. "
        "Fields: name, company, department, title, email, phone, address, website. "
        "Put every phone/mobile/fax/WhatsApp number into phone, separated by ' / '. "
        "Additionally, categorize the company's industry from the following list: "
        f"{INDUSTRY_OPTIONS}. Return the data as a JSON object with these exact keys, including 'industry' "
        "as the last key. Leave keys empty if not found. Never invent missing values. "
        "Extract only the core company name (e.g., 'AWS' from 'AWS Commercial Sales'). "
        "For industry categorization, consider both the company name and title. "
        "Do not include any additional text outside the JSON object."
    )
    if not (raw_text or '').strip():
        return parse_card_text_locally(raw_text)
    llm_client = openrouter_client if env_any('OPENROUTER_API_KEY', 'openrouter_api_key') else None
    model = os.environ.get('OPENROUTER_TEXT_MODEL') or 'google/gemini-2.0-flash-001'
    if llm_client is None:
        if not os.environ.get('DEEPSEEK_API_KEY'):
            logger.warning('No OpenRouter or DeepSeek key; using local parser')
            return parse_card_text_locally(raw_text)
        llm_client = client
        model = 'deepseek-chat'
    try:
        completion = llm_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are an expert data extraction assistant tasked with parsing raw text from business cards and categorizing industries."},
                {"role": "user", "content": f"{prompt}\n\nText:\n{raw_text}"}
            ],
            stream=False
        )
        card_data_str = completion.choices[0].message.content
        cleaned_card_data_str = strip_json_fence(card_data_str)
        try:
            card_data = json.loads(cleaned_card_data_str)
            return card_data
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse cleaned DeepSeek response as JSON: {cleaned_card_data_str}, Error: {str(e)}")
            return parse_card_text_locally(raw_text)
    except Exception as e:
        logger.error(f"DeepSeek API error: {str(e)}")
        return parse_card_text_locally(raw_text)

def get_contacts(event, cors_headers):
    try:
        params = event.get('queryStringParameters') or {}
        user_id, auth_error = require_user(event, cors_headers, params=params)
        if auth_error:
            return auth_error
        items = [
            contact_for_client(item)
            for item in table.query_by_user(user_id)
            if not is_profile_record(item)
        ]
        return {
            'statusCode': 200,
            'body': json.dumps(items),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error retrieving contacts: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def get_network_analysis(event, cors_headers):
    try:
        params = event.get('queryStringParameters') or {}
        user_id, auth_error = require_user(event, cors_headers, params=params)
        if auth_error:
            return auth_error
        contacts = [item for item in table.query_by_user(user_id) if not is_profile_record(item)]

        nodes = []
        links = []
        company_counts = {}
        company_nodes = set()

        for contact in contacts:
            nodes.append({
                'id': contact['cardId'],
                'name': contact.get('name', 'Unknown'),
                'type': 'person',
                'company': contact.get('company', 'Unknown')
            })
            company = contact.get('company', 'Unknown')
            company_counts[company] = company_counts.get(company, 0) + 1
            company_nodes.add(company)
            links.append({
                'source': contact['cardId'],
                'target': company,
                'type': 'works_at'
            })

        for company in company_nodes:
            nodes.append({
                'id': company,
                'name': company,
                'type': 'company',
                'count': company_counts.get(company, 0)
            })

        clusters = {}
        for contact in contacts:
            company = contact.get('company', 'Unknown')
            if company not in clusters:
                clusters[company] = []
            clusters[company].append(contact['cardId'])

        influence = sorted(
            [{'company': company, 'count': count} for company, count in company_counts.items()],
            key=lambda x: x['count'],
            reverse=True
        )[:5]

        analysis_result = {
            'nodes': nodes,
            'links': links,
            'clusters': clusters,
            'influence': influence,
            'total_contacts': len(contacts),
            'unique_companies': len(company_nodes)
        }

        return {
            'statusCode': 200,
            'body': json.dumps(analysis_result),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error in network analysis: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def delete_all_contacts(event, cors_headers):
    try:
        body = json.loads(event['body'])
        user_id, auth_error = require_user(event, cors_headers, body=body)
        if auth_error:
            return auth_error

        items = table.query_by_user(user_id)
        deleted_count = 0
        
        # Delete each scanned contact and its associated image (keep My Card)
        for item in items:
            if is_profile_record(item):
                continue
            card_id = item['cardId']
            table.delete_item(user_id, card_id)
            delete_stored_image(user_id, card_id)
            deleted_count += 1

        return {
            'statusCode': 200,
            'body': json.dumps({'message': f'Successfully deleted {deleted_count} contacts and their images'}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error deleting all contacts: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def delete_contact(event, cors_headers):
    try:
        card_id = (event.get('pathParameters') or {}).get('cardId')
        user_id, auth_error = require_user(event, cors_headers, params=event.get('queryStringParameters') or {})
        if auth_error:
            return auth_error
        if not card_id:
            raise KeyError("cardId is required")

        table.delete_item(user_id, card_id)
        delete_stored_image(user_id, card_id)

        return {
            'statusCode': 200,
            'body': json.dumps({'message': f"Contact {card_id} and its image deleted successfully"}),
            'headers': cors_headers
        }
    except KeyError as e:
        logger.error(f"KeyError: {str(e)}")
        return {
            'statusCode': 400,
            'body': json.dumps({'error': f'Missing key: {str(e)}'}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error deleting contact: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def update_contact(event, cors_headers):
    """Update a specific contact card."""
    try:
        card_id = (event.get('pathParameters') or {}).get('cardId')
        user_id, auth_error = require_user(event, cors_headers, params=event.get('queryStringParameters') or {})
        if auth_error:
            return auth_error
        if not card_id:
            raise KeyError("cardId is required")

        body = json.loads(event['body'])
        existing_contact = table.get_item(user_id, card_id)
        if not existing_contact:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': f"Contact {card_id} not found"}),
                'headers': cors_headers
            }
        
        # Create updated contact by merging existing contact with new data
        tags = body.get('tags', existing_contact.get('tags', []))
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(',') if t.strip()]
        elif not isinstance(tags, list):
            tags = []

        updated_contact = {
            'userId': user_id,
            'cardId': card_id,
            'name': body.get('name', existing_contact.get('name', '')),
            'company': body.get('company', existing_contact.get('company', '')),
            'department': body.get('department', existing_contact.get('department', '')),
            'industry': body.get('industry', existing_contact.get('industry', '')),
            'title': body.get('title', existing_contact.get('title', '')),
            'email': body.get('email', existing_contact.get('email', '')),
            'phone': body.get('phone', existing_contact.get('phone', '')),
            'address': body.get('address', existing_contact.get('address', '')),
            'website': body.get('website', existing_contact.get('website', '')),
            'dateAdded': body.get('dateAdded', existing_contact.get('dateAdded', datetime.now().isoformat())),
            'notes': body.get('notes', existing_contact.get('notes', '')),
            'tags': tags,
            'followUpDate': body.get('followUpDate', existing_contact.get('followUpDate', ''))
        }
        
        # Preserve image URLs if they exist in the original contact
        if 'imageUrl' in existing_contact:
            updated_contact['imageUrl'] = existing_contact['imageUrl']
        if 'backImageUrl' in existing_contact:
            updated_contact['backImageUrl'] = existing_contact['backImageUrl']
        if 'sides' in existing_contact:
            updated_contact['sides'] = existing_contact['sides']
            
        # Also preserve any other fields that might exist in the original contact
        for key, value in existing_contact.items():
            if key not in updated_contact:
                updated_contact[key] = value

        table.put_item(updated_contact)

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f"Contact {card_id} updated successfully",
                'contact': contact_for_client(updated_contact),
            }),
            'headers': cors_headers
        }
    except KeyError as e:
        logger.error(f"KeyError: {str(e)}")
        return {
            'statusCode': 400,
            'body': json.dumps({'error': f'Missing key: {str(e)}'}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error updating contact: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def delete_stored_image(user_id, card_id):
    if hasattr(table, 'delete_card_images'):
        try:
            table.delete_card_images(user_id, card_id)
        except Exception as err:
            logger.warning('Error deleting stored card images: %s', err)
    if not (s3_client and BACKEND_BUCKET_NAME):
        return
    for suffix in ('', '-back'):
        try:
            image_key = f"{user_id}/cards/{card_id}{suffix}.jpg"
            s3_client.delete_object(Bucket=BACKEND_BUCKET_NAME, Key=image_key)
            logger.info(f"Deleted image from S3: {image_key}")
        except Exception as e:
            logger.warning(f"Error deleting image from S3: {str(e)}")


def upload_image_to_s3(image_bytes, card_id, user_id, side='front'):
    """Upload card image to S3 or durable DB image store (never embed in contact JSON)."""
    if s3_client and BACKEND_BUCKET_NAME:
        suffix = '-back' if side == 'back' else ''
        key = f"{user_id}/cards/{card_id}{suffix}.jpg"
        try:
            s3_client.put_object(
                Bucket=BACKEND_BUCKET_NAME,
                Key=key,
                Body=image_bytes,
                ContentType='image/jpeg'
            )
            return f"s3://{BACKEND_BUCKET_NAME}/{key}"
        except Exception as e:
            logger.error(f"Error uploading image to S3: {str(e)}")
            raise e

    if hasattr(table, 'put_card_image'):
        try:
            return table.put_card_image(user_id, card_id, side, image_bytes, 'image/jpeg')
        except Exception as err:
            logger.error('Durable image store failed: %s', err)
            raise err

    # Last resort — should not happen when Postgres/Blob store is configured
    encoded = base64.b64encode(image_bytes).decode('utf-8')
    return f'data:image/jpeg;base64,{encoded}'


def get_image(event, cors_headers):
    try:
        card_id = (event.get('pathParameters') or {}).get('cardId')
        user_id, auth_error = require_user(event, cors_headers, params=event.get('queryStringParameters') or {})
        if auth_error:
            return auth_error
        if not card_id:
            raise KeyError("cardId is required")

        contact = table.get_item(user_id, card_id) or {}
        params = event.get('queryStringParameters') or {}
        side = (params.get('side') or 'front').lower()
        if side not in ('front', 'back'):
            side = 'front'
        image_url = contact.get('backImageUrl') if side == 'back' else contact.get('imageUrl')
        image_url = image_url or ''

        # Preferred path: dedicated card_images table / JSON image map
        if hasattr(table, 'get_card_image'):
            stored = table.get_card_image(user_id, card_id, side)
            if stored and stored.get('bytes'):
                return {
                    'statusCode': 200,
                    'headers': {
                        **cors_headers,
                        'Content-Type': stored.get('content_type') or 'image/jpeg',
                        'Cache-Control': 'private, max-age=3600',
                    },
                    'body': base64.b64encode(stored['bytes']).decode('ascii'),
                    'isBase64Encoded': True,
                }

        if image_url.startswith('data:'):
            header, encoded = image_url.split(',', 1)
            mime = 'image/jpeg'
            if 'image/png' in header:
                mime = 'image/png'
            elif 'image/webp' in header:
                mime = 'image/webp'
            # Migrate legacy embedded images into durable store for next fetch
            try:
                if hasattr(table, 'put_card_image'):
                    raw = base64.b64decode(encoded)
                    table.put_card_image(user_id, card_id, side, raw, mime)
                    patched = dict(contact)
                    patched['imageUrl' if side == 'front' else 'backImageUrl'] = f'db:{side}'
                    table.put_item(patched)
            except Exception as migrate_err:
                logger.warning('Could not migrate legacy data-URL image: %s', migrate_err)
            return {
                'statusCode': 200,
                'headers': {
                    **cors_headers,
                    'Content-Type': mime,
                    'Cache-Control': 'private, max-age=3600',
                },
                'body': encoded,
                'isBase64Encoded': True
            }

        if not (s3_client and BACKEND_BUCKET_NAME):
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Image not found'}),
                'headers': cors_headers
            }

        key = f"{user_id}/cards/{card_id}-back.jpg" if side == 'back' else f"{user_id}/cards/{card_id}.jpg"
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': BACKEND_BUCKET_NAME,
                'Key': key
            },
            ExpiresIn=3600
        )
        
        return {
            'statusCode': 302,
            'headers': {
                **cors_headers,
                'Location': url
            },
            'body': ''
        }
    except Exception as e:
        logger.error(f"Error retrieving image: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def query_version(event):
    params = event.get('queryStringParameters') or {}
    return params.get('version', '3.0')


def generate_vcard_from_body(event, cors_headers):
    """POST /vcard — generate a .vcf from submitted profile JSON."""
    try:
        data = parse_json_body(event)
        if not (data.get('name') or data.get('email') or data.get('phone')):
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'name, email, or phone is required'}),
                'headers': cors_headers
            }
        return vcard_response(data, cors_headers, version=data.get('version', '3.0'))
    except Exception as e:
        logger.error(f"Error generating vCard from body: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }


def get_own_profile(event, cors_headers):
    try:
        params = event.get('queryStringParameters') or {}
        user_id, auth_error = require_user(event, cors_headers, params=params)
        if auth_error:
            return auth_error
        item = table.get_item(user_id, PROFILE_CARD_ID)
        return {
            'statusCode': 200,
            'body': json.dumps({'profile': public_profile_payload(item) if item else None}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error reading profile: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }


def save_profile(event, cors_headers):
    try:
        body = parse_json_body(event)
        user_id, auth_error = require_user(event, cors_headers, body=body)
        if auth_error:
            return auth_error
        if not (body.get('name') or '').strip():
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'name is required'}),
                'headers': cors_headers
            }

        slug = sanitize_slug(body.get('slug') or body.get('name') or user_id) or sanitize_slug(user_id)
        existing = table.get_item(user_id, PROFILE_CARD_ID) or {}

        if slug:
            alias = table.get_item(f'slug:{slug}', SLUG_ALIAS_CARD_ID)
            if alias and alias.get('ownerUserId') and alias.get('ownerUserId') != user_id:
                return {
                    'statusCode': 409,
                    'body': json.dumps({'error': 'That public link is already taken'}),
                    'headers': cors_headers
                }

        avatar = body.get('avatar') or body.get('avatarUrl') or existing.get('avatar', '')
        if isinstance(avatar, str) and len(avatar) > MAX_AVATAR_CHARS:
            avatar = existing.get('avatar', '') if not str(existing.get('avatar', '')).startswith('data:') else ''

        item = {
            'userId': user_id,
            'cardId': PROFILE_CARD_ID,
            'kind': 'profile',
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'dateAdded': existing.get('dateAdded', datetime.now(timezone.utc).isoformat()),
        }
        for key in PROFILE_FIELDS:
            if key == 'slug':
                item[key] = slug
            elif key == 'avatar':
                item[key] = avatar
            else:
                item[key] = body.get(key, existing.get(key, ''))

        table.put_item(item)

        old_slug = sanitize_slug(existing.get('slug'))
        if old_slug and old_slug != slug:
            table.delete_item(f'slug:{old_slug}', SLUG_ALIAS_CARD_ID)
        if slug:
            table.put_item({
                'userId': f'slug:{slug}',
                'cardId': SLUG_ALIAS_CARD_ID,
                'kind': 'slug-alias',
                'ownerUserId': user_id
            })

        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Profile saved', 'profile': public_profile_payload(item)}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error saving profile: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }


def get_public_profile(event, cors_headers):
    try:
        params = event.get('pathParameters') or {}
        slug = params.get('slug') or event.get('path', '').rstrip('/').split('/')[-1]
        item = lookup_profile(slug)
        if not item:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Profile not found'}),
                'headers': cors_headers
            }
        return {
            'statusCode': 200,
            'body': json.dumps({'profile': public_profile_payload(item)}),
            'headers': cors_headers
        }
    except Exception as e:
        logger.error(f"Error reading public profile: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }


def get_profile_vcard(event, cors_headers):
    try:
        params = event.get('pathParameters') or {}
        slug = params.get('slug') or event.get('path', '').rstrip('/').split('/')[-1]
        item = lookup_profile(slug)
        if not item:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Profile not found'}),
                'headers': cors_headers
            }
        return vcard_response(item, cors_headers, version=query_version(event))
    except Exception as e:
        logger.error(f"Error generating profile vCard: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }


def get_vcard(event, cors_headers):
    """Generate and return a vCard file for a scanned contact."""
    try:
        card_id = (event.get('pathParameters') or {}).get('cardId') or event.get('path', '').rstrip('/').split('/')[-1]
        user_id, auth_error = require_user(event, cors_headers, params=event.get('queryStringParameters') or {})
        if auth_error:
            return auth_error

        if card_id == PROFILE_CARD_ID:
            item = lookup_profile(user_id)
            if not item:
                return {
                    'statusCode': 404,
                    'body': json.dumps({'error': 'Profile not found'}),
                    'headers': cors_headers
                }
            return vcard_response(item, cors_headers, version=query_version(event))
        
        response = table.get_item(user_id, card_id)
        
        if not response:
            return {
                'statusCode': 404,
                'body': json.dumps({'error': 'Contact not found'}),
                'headers': cors_headers
            }

        return vcard_response(response, cors_headers, version=query_version(event))
    except Exception as e:
        logger.error(f"Error generating vCard: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }

def handle_chat_message(event, cors_headers):
    """Handle chat messages using DeepSeek."""
    try:
        body = json.loads(event['body'])
        message = body.get('message')
        user_id, auth_error = require_user(event, cors_headers, body=body)
        if auth_error:
            return auth_error
        contacts = body.get('contacts', [])

        if not message:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Missing required fields'}),
                'headers': cors_headers
            }

        # Prepare context from contacts data
        context = []
        for contact in contacts:
            context.append({
                'name': contact.get('name', ''),
                'company': contact.get('company', ''),
                'title': contact.get('title', ''),
                'industry': contact.get('industry', ''),
                'email': contact.get('email', ''),
                'phone': contact.get('phone', ''),
                'location': contact.get('location', '')
            })

        prompt = (
            "You are a helpful assistant that helps users analyze their contact database. "
            "You have access to the user's contacts and can provide insights, answer questions, "
            "and help with data analysis. Be concise but informative in your responses. "
            "Focus on providing actionable insights and specific information from the contact database."
            "If a user's contact need to be included in your response, always start and end with a double line breaks."
        )

        if not env_any('OPENROUTER_API_KEY', 'openrouter_api_key', 'DEEPSEEK_API_KEY'):
            raise Exception('OPENROUTER_API_KEY is not set')
        chat_client = openrouter_client or client
        chat_model = (
            (os.environ.get('OPENROUTER_TEXT_MODEL') or 'google/gemini-2.0-flash-001')
            if openrouter_client else 'deepseek-chat'
        )
        try:
            completion = chat_client.chat.completions.create(
                model=chat_model,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": f"Here is the user's contact database: {json.dumps(context)}"},
                    {"role": "user", "content": message}
                ],
                stream=False,
                temperature=0.7,
                max_tokens=500
            )
            assistant_response = completion.choices[0].message.content

            return {
                'statusCode': 200,
                'body': json.dumps({'response': assistant_response}),
                'headers': cors_headers
            }
        except Exception as e:
            raise Exception(f"DeepSeek API error: {str(e)}")

    except Exception as e:
        logger.error(f"Error handling chat message: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
            'headers': cors_headers
        }