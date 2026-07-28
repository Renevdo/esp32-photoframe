#ifndef WEBAPP_ASSETS_H
#define WEBAPP_ASSETS_H

#include <stdint.h>

#include "esp_http_server.h"

/**
 * @brief The webapp embedded into flash, gzipped.
 *
 * webapp/vite-plugins/gzip-assets.js writes a .gz beside each file the webapp
 * build emits, and main/CMakeLists.txt embeds those. Two servers hand these
 * bytes out: the main HTTP server and the provisioning captive portal. They
 * share this header so the symbol names cannot drift apart, which is exactly
 * what happens when only one of them is updated (the link then fails on
 * _binary_*_start).
 */
extern const uint8_t index_html_start[] asm("_binary_index_html_gz_start");
extern const uint8_t index_html_end[] asm("_binary_index_html_gz_end");
extern const uint8_t index_css_start[] asm("_binary_index_css_gz_start");
extern const uint8_t index_css_end[] asm("_binary_index_css_gz_end");
extern const uint8_t index_js_start[] asm("_binary_index_js_gz_start");
extern const uint8_t index_js_end[] asm("_binary_index_js_gz_end");
extern const uint8_t index2_js_start[] asm("_binary_index2_js_gz_start");
extern const uint8_t index2_js_end[] asm("_binary_index2_js_gz_end");
extern const uint8_t exif_reader_js_start[] asm("_binary_exif_reader_js_gz_start");
extern const uint8_t exif_reader_js_end[] asm("_binary_exif_reader_js_gz_end");
extern const uint8_t browser_js_start[] asm("_binary_browser_js_gz_start");
extern const uint8_t browser_js_end[] asm("_binary_browser_js_gz_end");
extern const uint8_t vite_browser_external_js_start[] asm(
    "_binary___vite_browser_external_js_gz_start");
extern const uint8_t vite_browser_external_js_end[] asm(
    "_binary___vite_browser_external_js_gz_end");
extern const uint8_t icon_svg_start[] asm("_binary_icon_svg_gz_start");
extern const uint8_t icon_svg_end[] asm("_binary_icon_svg_gz_end");

/**
 * @brief Send an embedded asset as-is, telling the browser it is gzipped.
 *
 * The device never decompresses: the stored bytes go straight out. The
 * encoding is not negotiated against Accept-Encoding because only a browser
 * ever loads the webapp, and every browser advertises gzip.
 */
static inline esp_err_t webapp_send_asset(httpd_req_t *req, const char *content_type,
                                          const uint8_t *start, const uint8_t *end)
{
    httpd_resp_set_type(req, content_type);
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    return httpd_resp_send(req, (const char *) start, (size_t) (end - start));
}

#endif  // WEBAPP_ASSETS_H
