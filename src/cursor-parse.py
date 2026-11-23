# SPDX-FileCopyrightText: 2026 ganyuke
# SPDX-License-Identifier: GPL-2.0-or-later

# parse the cursor ide's sign-in from its SQLite database with Python
# since GJS doesn't have SQLite support
import base64
import ctypes as C
import ctypes.util
import hashlib
import json
import pathlib
import sqlite3
import sys


def native(library, name, result, *arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = list(arguments)
    return function


def _cursor_passwords(application):
    secret = C.CDLL('libsecret-1.so.0')
    glib = C.CDLL('libglib-2.0.so.0')
    objects = C.CDLL('libgobject-2.0.so.0')
    ptr = C.c_void_p
    text = C.c_char_p
    schema_new = native(secret, 'secret_schema_new', ptr, text, C.c_int)
    schema_dont_match_name = 1 << 1
    schema = schema_new(b'chrome_libsecret_os_crypt_password_v2', schema_dont_match_name,
                        text(b'application'), C.c_int(0), ptr())
    table = native(glib, 'g_hash_table_new', ptr, ptr, ptr)(
        C.cast(glib.g_str_hash, ptr), C.cast(glib.g_str_equal, ptr))
    app_key, app_value = text(b'application'), text(application)
    native(glib, 'g_hash_table_insert', C.c_int, ptr, ptr, ptr)(table, app_key, app_value)
    error = ptr()
    # don't unlock the keyring during background refreshes
    search_all = 1 << 1
    search_load_secrets = 1 << 3
    items = native(secret, 'secret_service_search_sync', ptr,
                   ptr, ptr, ptr, C.c_int, ptr, C.POINTER(ptr))(
                       None, schema, table, search_all | search_load_secrets, None, C.byref(error))

    class List(C.Structure):
        pass
    List._fields_ = [('data', ptr), ('next', C.POINTER(List)), ('prev', ptr)]
    passwords = []
    node = C.cast(items, C.POINTER(List))
    try:
        while node:
            item = node.contents.data
            value = native(secret, 'secret_item_get_secret', ptr, ptr)(item)
            if value:
                try:
                    password = native(secret, 'secret_value_get_text', text, ptr)(value)
                    if password is not None:
                        passwords.append(password)
                finally:
                    native(secret, 'secret_value_unref', None, ptr)(value)
            native(objects, 'g_object_unref', None, ptr)(item)
            node = node.contents.next
    finally:
        native(glib, 'g_list_free', None, ptr)(items)
        native(glib, 'g_hash_table_unref', None, ptr)(table)
        native(secret, 'secret_schema_unref', None, ptr)(schema)
        if error:
            native(glib, 'g_error_free', None, ptr)(error)
    return passwords


def cursor_passwords():
    # keyring lookups are case-sensitive
    return _cursor_passwords(b'Cursor') + _cursor_passwords(b'cursor')


def decrypt(ciphertext, password):
    crypto = C.CDLL(ctypes.util.find_library('crypto') or 'libcrypto.so.3')
    ptr = C.c_void_p
    key = hashlib.pbkdf2_hmac('sha1', password, b'saltysalt', 1, 16)
    context = native(crypto, 'EVP_CIPHER_CTX_new', ptr)()
    if not context:
        raise ValueError('Cannot initialize token decryption')
    output = C.create_string_buffer(len(ciphertext) + 16)
    length, tail = C.c_int(), C.c_int()
    try:
        cipher = native(crypto, 'EVP_aes_128_cbc', ptr)()
        if native(crypto, 'EVP_DecryptInit_ex', C.c_int, ptr, ptr, ptr, ptr, ptr)(
                context, cipher, None, key, b' ' * 16) != 1:
            raise ValueError('Cannot initialize token decryption')
        if native(crypto, 'EVP_DecryptUpdate', C.c_int, ptr, ptr, ptr, ptr, C.c_int)(
                context, output, C.byref(length), ciphertext, len(ciphertext)) != 1:
            raise ValueError('Cannot decrypt token')
        if native(crypto, 'EVP_DecryptFinal_ex', C.c_int, ptr, ptr, ptr)(
                context, C.byref(output, length.value), C.byref(tail)) != 1:
            raise ValueError('Cannot decrypt token')
        return output.raw[:length.value + tail.value].decode('utf-8')
    finally:
        native(crypto, 'EVP_CIPHER_CTX_free', None, ptr)(context)


def decode_token(value):
    if isinstance(value, bytes):
        utf16 = len(value) % 2 == 0 and value and all(
            0 < value[i] < 128 and value[i + 1] == 0 for i in range(0, len(value), 2))
        value = value.decode('utf-16le' if utf16 else 'utf-8')
    prefix = 'cursor-safe-storage:v1:'
    if not value.startswith(prefix):
        if value.startswith('cursor-safe-storage:'):
            raise ValueError('Unsupported Cursor token encryption version')
        return value
    encrypted = base64.b64decode(value[len(prefix):], validate=True)
    version, ciphertext = encrypted[:3], encrypted[3:]
    if version not in (b'v10', b'v11') or not ciphertext or len(ciphertext) % 16:
        raise ValueError('Unsupported Cursor encrypted token format')
    passwords = [b'peanuts'] if version == b'v10' else cursor_passwords()
    for password in passwords:
        try:
            token = decrypt(ciphertext, password)
            part = token.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
            if isinstance(claims, dict) and isinstance(claims.get('sub'), str) and claims['sub']:
                return token
        except (ValueError, UnicodeError, IndexError):
            continue
    raise ValueError('Cannot decrypt Cursor token with the unlocked desktop keyring')


def read_token(path):
    with sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").fetchone()
    return decode_token(row[0]) if row and row[0] else ''


if __name__ == '__main__':
    try:
        print(read_token(sys.argv[1]))
    except (OSError, ValueError, sqlite3.Error):
        print('Cannot read Cursor sign-in. Check the unlocked desktop keyring and system libsecret/OpenSSL libraries.', file=sys.stderr)
        sys.exit(1)
