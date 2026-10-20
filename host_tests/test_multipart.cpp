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

TEST(MultipartDelimiter, UnquotesQuotedBoundary)
{
    char out[128];
    int len = multipart_delimiter("multipart/form-data; boundary=\"abc;def\"; charset=utf-8", out,
                                  sizeof(out));
    EXPECT_EQ(std::string(out, len), "\r\n--abc;def");
    EXPECT_EQ(multipart_delimiter("multipart/form-data; boundary=\"abc", out, sizeof(out)), -1);
    EXPECT_EQ(multipart_delimiter("multipart/form-data; boundary=\"\"", out, sizeof(out)), -1);
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

static const std::string kFirstHeaders =
    "------formdata-undici-0123456789\r\n"
    "Content-Disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\n"
    "Content-Type: image/png\r\n"
    "\r\n";

TEST(MultipartHeaders, CompleteOnlyOnceTheBlankLineArrivesAtEveryReadSplit)
{
    std::string stream = kFirstHeaders + "\x89PNG body";
    for (size_t split = 0; split <= stream.size(); split++) {
        // The bytes past buf_len hold a blank line of their own, which must not be seen.
        std::string buf = stream.substr(0, split) + "\r\n\r\n";
        multipart_part_t part;
        multipart_headers_status_t status = multipart_parse_headers(buf.data(), (int) split, &part);
        if (split < kFirstHeaders.size()) {
            EXPECT_EQ(status, MULTIPART_HEADERS_PENDING) << "split " << split;
            continue;
        }
        ASSERT_EQ(status, MULTIPART_HEADERS_DONE) << "split " << split;
        EXPECT_EQ(part.header_len, (int) kFirstHeaders.size()) << "split " << split;
        EXPECT_STREQ(part.name, "image") << "split " << split;
        EXPECT_TRUE(part.has_filename) << "split " << split;
        EXPECT_STREQ(part.filename, "photo.png") << "split " << split;
    }
}

TEST(MultipartHeaders, HeadersAfterDelimiter)
{
    // What follows a delimiter: the rest of the boundary line, then the headers.
    std::string buf =
        "\r\ncontent-disposition: form-data; filename=\"t.jpg\"; name=thumbnail\r\n\r\nx";
    multipart_part_t part;
    ASSERT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part), MULTIPART_HEADERS_DONE);
    EXPECT_EQ(part.header_len, (int) buf.size() - 1);
    EXPECT_STREQ(part.name, "thumbnail");
    EXPECT_STREQ(part.filename, "t.jpg");
}

TEST(MultipartHeaders, FieldWithoutFilename)
{
    std::string buf = "\r\nContent-Disposition: form-data; name=\"filename\"\r\n\r\n";
    multipart_part_t part;
    ASSERT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part), MULTIPART_HEADERS_DONE);
    EXPECT_STREQ(part.name, "filename");
    EXPECT_FALSE(part.has_filename);
}

TEST(MultipartHeaders, NoHeaders)
{
    std::string buf = "\r\n\r\nbody";
    multipart_part_t part;
    ASSERT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part), MULTIPART_HEADERS_DONE);
    EXPECT_EQ(part.header_len, 4);
    EXPECT_STREQ(part.name, "");
    EXPECT_FALSE(part.has_filename);
}

TEST(MultipartHeaders, BlockWithoutBlankLineIsTooLong)
{
    std::string buf = "\r\nContent-Disposition: form-data; name=\"image\"\r\nX-Pad: ";
    buf.append(MULTIPART_MAX_HEADER_LEN, 'a');
    multipart_part_t part;
    EXPECT_EQ(multipart_parse_headers(buf.data(), MULTIPART_MAX_HEADER_LEN - 1, &part),
              MULTIPART_HEADERS_PENDING);
    EXPECT_EQ(multipart_parse_headers(buf.data(), MULTIPART_MAX_HEADER_LEN, &part),
              MULTIPART_HEADERS_TOO_LONG);
    EXPECT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part),
              MULTIPART_HEADERS_TOO_LONG);
}

TEST(MultipartHeaders, BlankLinePastTheLimitIsTooLong)
{
    std::string buf(MULTIPART_MAX_HEADER_LEN - 3, 'a');
    buf += "\r\n\r\n";
    multipart_part_t part;
    EXPECT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part),
              MULTIPART_HEADERS_TOO_LONG);
    buf.erase(0, 1);
    ASSERT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part), MULTIPART_HEADERS_DONE);
    EXPECT_EQ(part.header_len, MULTIPART_MAX_HEADER_LEN);
}

TEST(MultipartHeaders, LongFilenameIsTruncated)
{
    std::string name(400, 'n');
    std::string buf =
        "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" + name + ".png\"\r\n\r\n";
    multipart_part_t part;
    ASSERT_EQ(multipart_parse_headers(buf.data(), (int) buf.size(), &part), MULTIPART_HEADERS_DONE);
    EXPECT_EQ(std::string(part.filename), name.substr(0, sizeof(part.filename) - 1));
}
