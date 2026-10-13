import assert from "node:assert";
import { isRowSubmitted, collectQueueWithBoundary } from "./automation/dual/cleanframe.js";

// Mock helper to create mock row objects
function createMockRow({
  col0Text = "video.mp4",
  col1Href = "https://www.instagram.com/reel/ABC123xyz/",
  clipper = "clipper1",
  editor = "editor1",
  caption = "Great video",
  submitText = "Submit",
  submitTitle = "Click to mark SUBMITTED",
  hasGreenCheck = false,
  publishStatus = "Published"
}) {
  return {
    locator: (selector) => {
      if (selector === "td") {
        return {
          nth: (colIdx) => {
            if (colIdx === 0) {
              return {
                innerText: async () => col0Text,
                locator: (sub) => ({
                  first: () => ({
                    count: async () => 0,
                    getAttribute: async () => ""
                  })
                })
              };
            }
            if (colIdx === 1) {
              return {
                innerText: async () => col1Href || "Not published",
                locator: (sub) => ({
                  first: () => ({
                    count: async () => (col1Href ? 1 : 0),
                    getAttribute: async (attr) => (attr === "href" ? col1Href : "")
                  })
                })
              };
            }
            if (colIdx === 2) {
              return { innerText: async () => editor };
            }
            if (colIdx === 3) {
              return { innerText: async () => clipper };
            }
            if (colIdx === 4) {
              return {
                innerText: async () => caption,
                locator: () => ({
                  getAttribute: async () => caption
                })
              };
            }
            if (colIdx === 5) {
              return {
                innerText: async () => submitText,
                locator: (sub) => {
                  if (sub.includes("circle-check")) {
                    return { count: async () => (hasGreenCheck ? 1 : 0) };
                  }
                  // button
                  return {
                    first: () => ({
                      getAttribute: async (attr) => (attr === "title" ? submitTitle : ""),
                      innerText: async () => submitText,
                      isVisible: async () => true,
                      scrollIntoViewIfNeeded: async () => {},
                      click: async () => {}
                    })
                  };
                }
              };
            }
            if (colIdx === 7) {
              return { innerText: async () => publishStatus };
            }
            return {
              innerText: async () => "",
              locator: () => ({ first: () => ({ count: async () => 0 }) })
            };
          }
        };
      }
      return { nth: () => ({}) };
    }
  };
}

function createMockPage(rows) {
  return {
    evaluate: async () => {},
    waitForTimeout: async () => {},
    locator: (selector) => {
      if (selector === "tbody tr") {
        return {
          count: async () => rows.length,
          nth: (idx) => rows[idx]
        };
      }
      return { count: async () => 0 };
    }
  };
}

async function runTests() {
  console.log("==================================================");
  console.log("RUNNING LOAD CLIPS STOP-AT-SUBMITTED LOGIC TESTS");
  console.log("==================================================");

  // Test 1: First clip is Submitted → load zero clips and stop
  {
    console.log("\n--- TEST 1: First clip is Submitted → load zero clips and stop ---");
    const rows = [
      createMockRow({
        submitText: "Submitted ✓",
        submitTitle: "Click to mark NOT SUBMITTED",
        hasGreenCheck: true,
        col1Href: "https://www.instagram.com/reel/clip1/"
      }),
      createMockRow({
        submitText: "Submit",
        submitTitle: "Click to mark SUBMITTED",
        col1Href: "https://www.instagram.com/reel/clip2/"
      })
    ];
    const page = createMockPage(rows);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 0, "Queue length must be 0");
    console.log("✓ TEST 1 PASSED: Loaded 0 clips, stopped at Row 1");
  }

  // Test 2: First two clips are unsubmitted, third is Submitted → load the first two and stop at third
  {
    console.log("\n--- TEST 2: First two unsubmitted, third Submitted → load 2 clips and stop ---");
    const rows = [
      createMockRow({
        submitText: "Submit",
        col1Href: "https://www.instagram.com/reel/clip1/"
      }),
      createMockRow({
        submitText: "Submit",
        col1Href: "https://www.instagram.com/reel/clip2/"
      }),
      createMockRow({
        submitText: "Submitted ✓",
        hasGreenCheck: true,
        col1Href: "https://www.instagram.com/reel/clip3/"
      }),
      createMockRow({
        submitText: "Submit",
        col1Href: "https://www.instagram.com/reel/clip4/"
      })
    ];
    const page = createMockPage(rows);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 2, "Queue length must be 2");
    assert.strictEqual(result.queue[0].instagramLink, "https://www.instagram.com/reel/clip1/");
    assert.strictEqual(result.queue[1].instagramLink, "https://www.instagram.com/reel/clip2/");
    console.log("✓ TEST 2 PASSED: Loaded exactly first 2 clips in order, stopped at Row 3");
  }

  // Test 3: First five clips unsubmitted, sixth is Submitted → load first five and stop
  {
    console.log("\n--- TEST 3: First five unsubmitted, sixth Submitted → load 5 clips and stop ---");
    const rows = [
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip1/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip2/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip3/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip4/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip5/" }),
      createMockRow({ submitText: "Submitted ✓", hasGreenCheck: true, col1Href: "https://www.instagram.com/reel/clip6/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip7/" })
    ];
    const page = createMockPage(rows);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 5, "Queue length must be 5");
    assert.strictEqual(result.queue[4].instagramLink, "https://www.instagram.com/reel/clip5/");
    console.log("✓ TEST 3 PASSED: Loaded exactly first 5 clips in order, stopped at Row 6");
  }

  // Test 4: No submitted clip exists → load all eligible clips in order
  {
    console.log("\n--- TEST 4: No submitted clip exists → load all eligible clips in order ---");
    const rows = [
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip1/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip2/" }),
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip3/" })
    ];
    const page = createMockPage(rows);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 3, "Queue length must be 3");
    assert.strictEqual(result.queue[0].instagramLink, "https://www.instagram.com/reel/clip1/");
    assert.strictEqual(result.queue[2].instagramLink, "https://www.instagram.com/reel/clip3/");
    console.log("✓ TEST 4 PASSED: Loaded all 3 clips in order");
  }

  // Test 5: A clip is Published but its Submit Mark is still Submit → treat it as unsubmitted
  {
    console.log("\n--- TEST 5: Clip is Published but Submit Mark is still Submit → treat as unsubmitted ---");
    const row = createMockRow({
      submitText: "Submit",
      submitTitle: "Click to mark SUBMITTED",
      publishStatus: "Published",
      col1Href: "https://www.instagram.com/reel/clip1/"
    });
    const isSub = await isRowSubmitted(row);
    assert.strictEqual(isSub, false, "Should be unsubmitted despite Published status");

    const page = createMockPage([
      row,
      createMockRow({ submitText: "Submitted ✓", hasGreenCheck: true, col1Href: "https://www.instagram.com/reel/clip2/" })
    ]);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 1, "Queue length must be 1");
    assert.strictEqual(result.queue[0].instagramLink, "https://www.instagram.com/reel/clip1/");
    console.log("✓ TEST 5 PASSED: Treated as unsubmitted, queued into load queue");
  }

  // Test 6: A clip is Submitted but its publish status is FAILED → still stop at the submitted clip
  {
    console.log("\n--- TEST 6: Clip is Submitted but publish status is FAILED → still stop at submitted clip ---");
    const row = createMockRow({
      submitText: "Submitted ✓",
      submitTitle: "Click to mark NOT SUBMITTED",
      hasGreenCheck: true,
      publishStatus: "❌ FAILED\n\nfetch.failed",
      col1Href: "https://www.instagram.com/reel/clip1/"
    });
    const isSub = await isRowSubmitted(row);
    assert.strictEqual(isSub, true, "Should be submitted despite FAILED publish status");

    const page = createMockPage([
      row,
      createMockRow({ submitText: "Submit", col1Href: "https://www.instagram.com/reel/clip2/" })
    ]);
    const result = await collectQueueWithBoundary(page, () => {});
    assert.strictEqual(result.queue.length, 0, "Queue length must be 0 (stopped at row 1)");
    console.log("✓ TEST 6 PASSED: Stopped scanning at row 1 despite FAILED publish status");
  }

  console.log("\n==================================================");
  console.log("ALL 6 TESTS PASSED SUCCESSFULLY!");
  console.log("==================================================");
}

runTests().catch(err => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
