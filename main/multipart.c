#include "multipart.h"

#include <stdio.h>
#include <string.h>

int multipart_delimiter(const char *content_type, char *out, size_t out_size)
{
    const char *start = strstr(content_type, "boundary=");
    if (!start) {
        return -1;
    }
    start += 9;
    const char *end = start + strcspn(start, "\r\n;");
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
