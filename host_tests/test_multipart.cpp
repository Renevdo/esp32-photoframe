#include <gtest/gtest.h>

#include <string>

extern "C" {
#include "multipart.h"
}

static const char *kContentType = "multipart/form-data; boundary=----formdata-undici-0123456789";
static const std::string kDelimiter = "\r\n------formdata-undici-0123456789";

// Feeds a part body plus what follows it through multipart_scan_body in
// fixed-size reads with the delimiter parsed from kContentType, the way
// parse_multipart_upload buffers the request, and returns what it would write.
static std::string drain_part(const std::string &stream, size_t chunk, std::string *rest)
{
    char delim[128];
    int delim_len = multipart_delimiter(kContentType, delim, sizeof(delim));
    std::string buf, out;
    size_t fed = 0;
    for (;;) {
        size_t n = std::min(chunk, stream.size() - fed);
        buf.append(stream, fed, n);
        fed += n;
        multipart_scan_t scan = multipart_scan_body(buf.data(), (int) buf.size(), delim, delim_len,
                                                    fed == stream.size());
        out.append(buf, 0, scan.write_len);
        buf.erase(0, scan.consumed);
        if (scan.found || (fed == stream.size() && buf.empty())) {
            break;
        }
    }
    if (rest) {
        *rest = buf + stream.substr(fed);
    }
    return out;
}

TEST(MultipartDelimiter, IncludesLeadingCrlf)
{
    char out[128];
    int len = multipart_delimiter(kContentType, out, sizeof(out));
    ASSERT_EQ(len, (int) kDelimiter.size());
    EXPECT_EQ(std::string(out, len), kDelimiter);
}

TEST(MultipartDelimiter, StopsAtParameterSeparator)
{
    char out[128];
    int len =
        multipart_delimiter("multipart/form-data; boundary=abc; charset=utf-8", out, sizeof(out));
    EXPECT_EQ(std::string(out, len), "\r\n--abc");
}

TEST(MultipartDelimiter, RejectsMissingOrOversizedBoundary)
{
    char out[16];
    EXPECT_EQ(multipart_delimiter("multipart/form-data", out, sizeof(out)), -1);
    EXPECT_EQ(multipart_delimiter("multipart/form-data; boundary=", out, sizeof(out)), -1);
    EXPECT_EQ(
        multipart_delimiter("multipart/form-data; boundary=0123456789abcdef", out, sizeof(out)),
        -1);
}

TEST(MultipartScan, PartBodyExcludesDelimiterCrlfAtEveryReadSplit)
{
    // Payload ends in its own CRLF and holds near-miss delimiters, which must all survive.
    std::string payload = "\x1f\x8b\x08 gzip bytes ------formdata-undici-0123456789 \r\n--x \r\n";
    std::string next = "\r\nContent-Disposition: form-data; name=\"thumbnail\"\r\n\r\n";
    std::string stream = payload + kDelimiter + next;

    for (size_t chunk = 1; chunk <= stream.size(); chunk++) {
        std::string rest;
        EXPECT_EQ(drain_part(stream, chunk, &rest), payload) << "chunk " << chunk;
        EXPECT_EQ(rest, next) << "chunk " << chunk;
    }
}

TEST(MultipartScan, EmptyPartBody)
{
    std::string stream = kDelimiter + "--\r\n";
    std::string rest;
    EXPECT_EQ(drain_part(stream, 4096, &rest), "");
    EXPECT_EQ(rest, "--\r\n");
}

TEST(MultipartScan, TruncatedBodyKeepsHeldBackBytes)
{
    std::string stream = "abc\r\n--formdata";
    EXPECT_EQ(drain_part(stream, 4, nullptr), stream);
}
