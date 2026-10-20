#pragma once

#include <stdbool.h>
#include <stddef.h>

// Streaming helpers for multipart/form-data bodies, kept free of ESP-IDF
// headers so they are host-tested.

// Writes the part delimiter "\r\n--<boundary>" taken from a Content-Type
// header value, quoted or not, into out (RFC 2046: the CRLF before the
// dash-boundary belongs to the delimiter, not to the part body). Returns its
// length, or -1 when the header has no boundary or it does not fit.
int multipart_delimiter(const char *content_type, char *out, size_t out_size);

typedef struct {
    int write_len;  // leading bytes of the buffer that are part body
    int consumed;   // bytes to drop from the front of the buffer
    bool found;     // the delimiter ended the part
} multipart_scan_t;

// Scans buffered part body for the delimiter. Without a match it holds back
// delim_len - 1 bytes so a delimiter split across reads is still found,
// unless input_done says no more bytes will arrive.
multipart_scan_t multipart_scan_body(const char *buf, int buf_len, const char *delim, int delim_len,
                                     bool input_done);

// Longest part header block accepted, blank line included.
#define MULTIPART_MAX_HEADER_LEN 2048

typedef enum {
    MULTIPART_HEADERS_PENDING,   // no blank line yet, read more
    MULTIPART_HEADERS_DONE,      // part filled in
    MULTIPART_HEADERS_TOO_LONG,  // no blank line within MULTIPART_MAX_HEADER_LEN bytes
} multipart_headers_status_t;

typedef struct {
    char name[64];
    char filename[256];
    bool has_filename;
    int header_len;  // bytes up to and including the blank line
} multipart_part_t;

// Parses the header block that starts the buffer (after the first boundary
// line or a delimiter) without reading past buf_len, taking name and filename
// from its Content-Disposition line.
multipart_headers_status_t multipart_parse_headers(const char *buf, int buf_len,
                                                   multipart_part_t *part);
