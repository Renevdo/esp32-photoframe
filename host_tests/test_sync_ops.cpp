#include <gtest/gtest.h>

#include <string>

extern "C" {
#include "sync_ops.h"
}

TEST(SyncName, RejectsTraversalAndEmpty)
{
    EXPECT_FALSE(sync_name_is_safe(""));
    EXPECT_FALSE(sync_name_is_safe(".."));
    EXPECT_FALSE(sync_name_is_safe("."));
    EXPECT_FALSE(sync_name_is_safe("a/b"));
    EXPECT_FALSE(sync_name_is_safe("a\\b"));
    std::string longname(64, 'x');
    EXPECT_FALSE(sync_name_is_safe(longname.c_str()));
    EXPECT_TRUE(sync_name_is_safe("Family Photos"));
    EXPECT_TRUE(sync_name_is_safe("pic.epdgz"));
}

TEST(SyncOpsParse, ParsesChangesResponse)
{
    const char *json =
        "{\"latest_seq\": 3, \"ops\": ["
        "{\"op\":\"put\",\"album\":\"fam\",\"file\":\"a.epdgz\",\"size\":123},"
        "{\"op\":\"delete\",\"album\":\"fam\",\"file\":\"b.epdgz\"},"
        "{\"op\":\"rmdir\",\"album\":\"old\"}]}";
    sync_changes_t out;
    ASSERT_TRUE(sync_ops_parse(json, &out));
    EXPECT_EQ(out.latest_seq, 3);
    EXPECT_FALSE(out.reset);
    ASSERT_EQ(out.op_count, 3);
    EXPECT_EQ(out.ops[0].type, SYNC_OP_PUT);
    EXPECT_STREQ(out.ops[0].album, "fam");
    EXPECT_STREQ(out.ops[0].file, "a.epdgz");
    EXPECT_EQ(out.ops[0].size, 123);
    EXPECT_EQ(out.ops[1].type, SYNC_OP_DELETE);
    EXPECT_EQ(out.ops[1].size, -1);
    EXPECT_EQ(out.ops[2].type, SYNC_OP_RMDIR);
    EXPECT_STREQ(out.ops[2].album, "old");
}

TEST(SyncOpsParse, ParsesResetFlag)
{
    sync_changes_t out;
    ASSERT_TRUE(sync_ops_parse("{\"reset\": true}", &out));
    EXPECT_TRUE(out.reset);
}

TEST(SyncOpsParse, ParsesEmptyOps)
{
    sync_changes_t out;
    ASSERT_TRUE(sync_ops_parse("{\"latest_seq\": 5, \"ops\": []}", &out));
    EXPECT_EQ(out.latest_seq, 5);
    EXPECT_EQ(out.op_count, 0);
}

TEST(SyncOpsParse, RejectsBadInput)
{
    sync_changes_t out;
    EXPECT_FALSE(sync_ops_parse("not json", &out));
    EXPECT_FALSE(sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"chmod\"}]}", &out));
    EXPECT_FALSE(
        sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"../"
                       "x\",\"file\":\"f\",\"size\":1}]}",
                       &out));
    EXPECT_FALSE(sync_ops_parse("{\"ops\": []}", &out));  // missing latest_seq
    EXPECT_FALSE(sync_ops_parse(
        "{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"a\",\"file\":\"f\"}]}",
        &out));  // put without size
}

TEST(SyncOpsParse, RejectsNonIntegerOrOutOfRangeNumbers)
{
    sync_changes_t out;
    // latest_seq must be an exact non-negative integer within double precision
    EXPECT_FALSE(sync_ops_parse("{\"latest_seq\": -1, \"ops\": []}", &out));
    EXPECT_FALSE(sync_ops_parse("{\"latest_seq\": 1.5, \"ops\": []}", &out));
    EXPECT_FALSE(sync_ops_parse("{\"latest_seq\": 1e20, \"ops\": []}", &out));
    // put size must fit int32
    EXPECT_FALSE(
        sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"a\",\"file\":\"f\","
                       "\"size\":2147483648}]}",
                       &out));  // INT32_MAX + 1
    EXPECT_FALSE(
        sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"a\",\"file\":\"f\","
                       "\"size\":1.5}]}",
                       &out));
    // boundary value is accepted
    EXPECT_TRUE(
        sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"a\",\"file\":\"f\","
                       "\"size\":2147483647}]}",
                       &out));
    EXPECT_EQ(out.ops[0].size, 2147483647);
}
