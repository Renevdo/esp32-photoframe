#include "multipart.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

int multipart_delimiter(const char *content_type, char *out, size_t out_size)
{
    const char *start = strstr(content_type, "boundary=");
    if (!start) {
        return -1;
    }
    start += 9;
    const char *end;
    if (*start == '"') {
        start++;
        end = strchr(start, '"');
        if (!end) {
            return -1;
        }
    } else {
        end = start + strcspn(start, "\r\n;");
    }
    int len = snprintf(out, out_size, "\r\n--%.*s", (int) (end - start), start);
    if (len < 0 || (size_t) len >= out_size || end == start) {
        return -1;
    }
    return len;
}

multipart_scan_t multipart_scan_body(const char *buf, int buf_len, const char *delim, int delim_len,
                                     bool input_done)
{
    multipart_scan_t scan = {0};
    for (int i = 0; i <= buf_len - delim_len; i++) {
        if (memcmp(buf + i, delim, delim_len) == 0) {
            scan.write_len = i;
            scan.consumed = i + delim_len;
            scan.found = true;
            return scan;
        }
    }
    if (input_done) {
        scan.write_len = buf_len;
    } else if (buf_len > delim_len - 1) {
        scan.write_len = buf_len - (delim_len - 1);
    }
    scan.consumed = scan.write_len;
    return scan;
}

static const char *find_bytes(const char *buf, int buf_len, const char *needle, int needle_len)
{
    for (int i = 0; i <= buf_len - needle_len; i++) {
        if (memcmp(buf + i, needle, needle_len) == 0) {
            return buf + i;
        }
    }
    return NULL;
}

static void copy_value(char *out, size_t out_size, const char *start, const char *end)
{
    size_t len = (size_t) (end - start);
    if (len >= out_size) {
        len = out_size - 1;
    }
    memcpy(out, start, len);
    out[len] = '\0';
}

// Reads the name and filename parameters of a Content-Disposition value in [p, end).
static void parse_disposition(const char *p, const char *end, multipart_part_t *part)
{
    while ((p = memchr(p, ';', end - p)) != NULL) {
        p++;
        while (p < end && (*p == ' ' || *p == '\t')) {
            p++;
        }
        const char *eq = memchr(p, '=', end - p);
        if (!eq) {
            return;
        }
        const char *key = p;
        size_t key_len = (size_t) (eq - key);
        const char *val = eq + 1;
        const char *val_end;
        if (val < end && *val == '"') {
            val++;
            val_end = memchr(val, '"', end - val);
            if (!val_end) {
                return;
            }
            p = val_end + 1;
        } else {
            val_end = memchr(val, ';', end - val);
            if (!val_end) {
                val_end = end;
            }
            p = val_end;
        }
        if (key_len == 4 && strncasecmp(key, "name", 4) == 0) {
            copy_value(part->name, sizeof(part->name), val, val_end);
        } else if (key_len == 8 && strncasecmp(key, "filename", 8) == 0) {
            copy_value(part->filename, sizeof(part->filename), val, val_end);
            part->has_filename = true;
        }
    }
}

multipart_headers_status_t multipart_parse_headers(const char *buf, int buf_len,
                                                   multipart_part_t *part)
{
    int search_len = buf_len < MULTIPART_MAX_HEADER_LEN ? buf_len : MULTIPART_MAX_HEADER_LEN;
    const char *blank = find_bytes(buf, search_len, "\r\n\r\n", 4);
    if (!blank) {
        return buf_len >= MULTIPART_MAX_HEADER_LEN ? MULTIPART_HEADERS_TOO_LONG
                                                   : MULTIPART_HEADERS_PENDING;
    }

    memset(part, 0, sizeof(*part));
    part->header_len = (int) (blank - buf) + 4;

    static const char kDisposition[] = "Content-Disposition:";
    const int disposition_len = sizeof(kDisposition) - 1;
    const char *line = buf;
    const char *block_end = blank + 2;
    while (line < block_end) {
        const char *eol = find_bytes(line, (int) (block_end - line), "\r\n", 2);
        if (eol - line > disposition_len && strncasecmp(line, kDisposition, disposition_len) == 0) {
            parse_disposition(line + disposition_len, eol, part);
        }
        line = eol + 2;
    }
    return MULTIPART_HEADERS_DONE;
}
