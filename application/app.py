import json
import os
import re
import uuid
import base64
import logging
import urllib.error
import urllib.request
from openai import OpenAI
from datetime import datetime, timezone

try:
    import boto3
except ImportError:
    boto3 = None

from store import JsonTable

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()

DYNAMODB_TABLE_NAME = os.environ.get('DYNAMODB_TABLE_NAME')
BACKEND_BUCKET_NAME = os.environ.get('BACKEND_BUCKET_NAME')
REGION = os.environ.get('AWS_REGION') or os.environ.get('REGION') or 'ap-southeast-1'
USE_AWS = bool(boto3 and DYNAMODB_TABLE_NAME)

# Set OpenAI API key for DeepSeek
client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY') or 'missing',
    base_url=os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
)

textract = None
s3_client = None
table = JsonTable()

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
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
        'Content-Type': 'application/json'
    }

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
            'body': json.dumps({'ok': True, 'service': 'folio'}),
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

def scan_business_card(event, context, cors_headers):
    try:
        body = json.loads(event['body'])
        user_id = body.get('userId', 'anonymous')
        images = body.get('images', [])
        raw_texts = body.get('rawTexts') or body.get('raw_texts') or []
        
        if not images:
            image_base64 = body.get('image')
            if not image_base64:
                raise KeyError("No images provided")
            images = [image_base64]
        if not raw_texts and body.get('rawText'):
            raw_texts = [body.get('rawText')]

        results = []
        for index, image_base64 in enumerate(images):
            if ',' in image_base64 and str(image_base64).lstrip().startswith('data:'):
                image_base64 = image_base64.split(',', 1)[1]
            image_bytes = base64.b64decode(image_base64)
            client_text = raw_texts[index] if index < len(raw_texts) else ''
            raw_text = extract_card_text(image_bytes, client_text)
            
            # Parse with DeepSeek
            card_data = parse_with_deepseek(raw_text)
            
            # Generate cardId and add metadata
            card_id = str(uuid.uuid4())
            card_data['userId'] = user_id
            card_data['cardId'] = card_id
            card_data['dateAdded'] = datetime.now().isoformat()
            
            # Upload the original image to S3
            image_url = upload_image_to_s3(image_bytes, card_id, user_id)
            
            # Store the image URL in card data
            card_data['imageUrl'] = image_url
            card_data.setdefault('notes', '')
            card_data.setdefault('tags', [])
            card_data.setdefault('followUpDate', '')
            
            table.put_item(card_data)
            public_card = dict(card_data)
            # Don't send megabyte data-URL images back in the HTTP response
            if str(public_card.get('imageUrl') or '').startswith('data:'):
                public_card['imageUrl'] = ''
            results.append(public_card)

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


def extract_text_with_gemini(image_bytes):
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        return ''
    model = os.environ.get('GEMINI_MODEL', 'gemini-2.0-flash')
    payload = json.dumps({
        'contents': [{
            'parts': [
                {'text': 'Extract all visible text from this business card. Return plain text only.'},
                {'inline_data': {'mime_type': 'image/jpeg', 'data': base64.b64encode(image_bytes).decode('utf-8')}},
            ]
        }]
    }).encode('utf-8')
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}'
    req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
        return '\n'.join(part.get('text', '') for part in parts).strip()
    except urllib.error.HTTPError as err:
        logger.warning('Gemini OCR failed: %s', err.read().decode('utf-8', errors='ignore'))
        return ''
    except Exception as err:
        logger.warning('Gemini OCR failed: %s', err)
        return ''


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

    email_match = re.search(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}', text, re.I)
    if email_match:
        data['email'] = email_match.group(0)

    url_match = re.search(r'(https?://[^\s]+|www\.[^\s]+)', text, re.I)
    if url_match:
        data['website'] = url_match.group(0).rstrip('.,;)')

    phone_match = re.search(r'(\+?\d[\d\s().\-]{7,}\d)', text)
    if phone_match:
        data['phone'] = re.sub(r'\s+', ' ', phone_match.group(0)).strip()

    skip = {
        data['email'].lower(),
        data['website'].lower(),
        data['phone'],
        data['phone'].replace(' ', ''),
    }
    leftover = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and line.strip().lower() not in skip and '@' not in line
    ]
    if leftover:
        data['name'] = leftover[0][:80]
        if len(leftover) > 1:
            data['company'] = leftover[1][:80]
        if len(leftover) > 2:
            data['title'] = leftover[2][:80]
    return data


def extract_card_text(image_bytes, client_text=''):
    text = (client_text or '').strip()
    if text:
        return text
    gemini_text = extract_text_with_gemini(image_bytes)
    if gemini_text:
        return gemini_text
    if textract:
        textract_response = textract.detect_document_text(Document={'Bytes': image_bytes})
        return extract_raw_text(textract_response)
    logger.warning('No server OCR available; continuing with client text only')
    return ''

def parse_with_deepseek(raw_text):
    prompt = (
        "Extract the following information from the provided business card text: "
        "name, company, department, title, email, phone, address, website. "
        "Additionally, categorize the company's industry from the following list: "
        "Technology, Healthcare, Finance, Manufacturing, Retail, Education, "
        "Government, Non-Profit, Media, Transportation, Energy, Agriculture, "
        "Construction, Hospitality, Legal, Consulting, Real Estate, Telecommunications, "
        "Other. Return the data as a JSON object with these exact keys, including 'industry' "
        "as the last key. Leave keys empty if not found. "
        "Extract only the core company name (e.g., 'AWS' from 'AWS Commercial Sales'). "
        "For industry categorization, consider both the company name and title. "
        "Do not include any additional text outside the JSON object."
    )
    if not (raw_text or '').strip() or not os.environ.get('DEEPSEEK_API_KEY'):
        if not os.environ.get('DEEPSEEK_API_KEY'):
            logger.warning('DEEPSEEK_API_KEY is not set; using local parser')
        return parse_card_text_locally(raw_text)
    try:
        completion = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": "You are an expert data extraction assistant tasked with parsing raw text from business cards and categorizing industries."},
                {"role": "user", "content": f"{prompt}\n\nText:\n{raw_text}"}
            ],
            stream=False
        )
        card_data_str = completion.choices[0].message.content
        cleaned_card_data_str = card_data_str.replace('```json', '').replace('```', '').strip()
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
        user_id = params.get('userId', 'anonymous')
        items = [item for item in table.query_by_user(user_id) if not is_profile_record(item)]
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
        user_id = params.get('userId') or (event.get('headers') or {}).get('userId') or 'anonymous'
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
        user_id = body.get('userId')
        
        if not user_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'userId is required'}),
                'headers': cors_headers
            }

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
        user_id = (event.get('queryStringParameters') or {}).get('userId')
        if not user_id:
            raise KeyError("userId is required")
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
        user_id = (event.get('queryStringParameters') or {}).get('userId')
        if not user_id:
            raise KeyError("userId is required")
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
        
        # Preserve imageUrl if it exists in the original contact
        if 'imageUrl' in existing_contact:
            updated_contact['imageUrl'] = existing_contact['imageUrl']
            
        # Also preserve any other fields that might exist in the original contact
        for key, value in existing_contact.items():
            if key not in updated_contact:
                updated_contact[key] = value

        table.put_item(updated_contact)

        return {
            'statusCode': 200,
            'body': json.dumps({'message': f"Contact {card_id} updated successfully", 'contact': updated_contact}),
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
    if not (s3_client and BACKEND_BUCKET_NAME):
        return
    try:
        image_key = f"{user_id}/cards/{card_id}.jpg"
        s3_client.delete_object(Bucket=BACKEND_BUCKET_NAME, Key=image_key)
        logger.info(f"Deleted image from S3: {image_key}")
    except Exception as e:
        logger.warning(f"Error deleting image from S3: {str(e)}")


def upload_image_to_s3(image_bytes, card_id, user_id):
    """Upload the original image to S3, or keep a data URL on Vercel."""
    if not (s3_client and BACKEND_BUCKET_NAME):
        encoded = base64.b64encode(image_bytes).decode('utf-8')
        return f'data:image/jpeg;base64,{encoded}'

    key = f"{user_id}/cards/{card_id}.jpg"
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


def get_image(event, cors_headers):
    try:
        card_id = (event.get('pathParameters') or {}).get('cardId')
        user_id = (event.get('queryStringParameters') or {}).get('userId')
        
        if not user_id:
            raise KeyError("userId is required")
        if not card_id:
            raise KeyError("cardId is required")

        contact = table.get_item(user_id, card_id) or {}
        image_url = contact.get('imageUrl') or ''
        if image_url.startswith('data:'):
            header, encoded = image_url.split(',', 1)
            mime = 'image/jpeg'
            if 'image/png' in header:
                mime = 'image/png'
            elif 'image/webp' in header:
                mime = 'image/webp'
            return {
                'statusCode': 200,
                'headers': {
                    **cors_headers,
                    'Content-Type': mime
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

        key = f"{user_id}/cards/{card_id}.jpg"
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
        user_id = params.get('userId')
        if not user_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'userId is required'}),
                'headers': cors_headers
            }
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
        user_id = (body.get('userId') or '').strip()
        if not user_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'userId is required'}),
                'headers': cors_headers
            }
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
        user_id = (event.get('queryStringParameters') or {}).get('userId')
        
        if not user_id:
            raise KeyError("userId is required")

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
        user_id = body.get('userId')
        contacts = body.get('contacts', [])

        if not message or not user_id:
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

        if not os.environ.get('DEEPSEEK_API_KEY'):
            raise Exception('DEEPSEEK_API_KEY is not set')
        try:
            completion = client.chat.completions.create(
                model="deepseek-chat",
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