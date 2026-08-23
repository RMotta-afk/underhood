import { describe, expect, test } from "bun:test";
import { analyzeCode } from "../analyze-code";
import type { AnalysisLanguage } from "../analyze-code";

// Multi-language extraction fixtures. The Python case is the original bug
// report: a Python binary search used to hit the silent emptyAnalysis
// fallback and collapse to a Start -> End topology.

const PYTHON_BINARY_SEARCH = `def binary_search(arr, target):
    left = 0
    right = len(arr) - 1

    while left <= right:
        mid = (left + right) // 2

        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            left = mid + 1
        else:
            right = mid - 1

    return -1

my_array = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91]
result = binary_search(my_array, 23)

if result != -1:
    print(f"Element found at index {result}")
else:
    print("Element not found in array")
`;

const JAVA_BINARY_SEARCH = `public class Search {
    public static int binarySearch(int[] arr, int target) {
        int left = 0;
        int right = arr.length - 1;
        while (left <= right) {
            int mid = (left + right) / 2;
            if (arr[mid] == target) {
                return mid;
            } else if (arr[mid] < target) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        return -1;
    }

    public static void main(String[] args) {
        System.out.println(binarySearch(new int[]{1, 2, 3}, 3));
    }
}
`;

const GO_BINARY_SEARCH = `package main

import "fmt"

func binarySearch(arr []int, target int) int {
	left, right := 0, len(arr)-1
	for left <= right {
		mid := (left + right) / 2
		if arr[mid] == target {
			return mid
		} else if arr[mid] < target {
			left = mid + 1
		} else {
			right = mid - 1
		}
	}
	return -1
}

func main() {
	fmt.Println(binarySearch([]int{1, 2, 3}, 3))
}
`;

const C_BINARY_SEARCH = `#include <stdio.h>

int binary_search(int arr[], int n, int target) {
    int left = 0;
    int right = n - 1;
    while (left <= right) {
        int mid = (left + right) / 2;
        if (arr[mid] == target) {
            return mid;
        } else if (arr[mid] < target) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}

int main(void) {
    int arr[] = {1, 2, 3};
    printf("%d\\n", binary_search(arr, 3, 3));
    return 0;
}
`;

const RUST_BINARY_SEARCH = `fn binary_search(arr: &[i32], target: i32) -> i32 {
    let mut left = 0i32;
    let mut right = arr.len() as i32 - 1;
    while left <= right {
        let mid = (left + right) / 2;
        if arr[mid as usize] == target {
            return mid;
        } else if arr[mid as usize] < target {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    -1
}

fn main() {
    println!("{}", binary_search(&[1, 2, 3], 3));
}
`;

const CS_BINARY_SEARCH = `using System;

class Search
{
    static int BinarySearch(int[] arr, int target)
    {
        int left = 0;
        int right = arr.Length - 1;
        while (left <= right)
        {
            int mid = (left + right) / 2;
            if (arr[mid] == target)
                return mid;
            else if (arr[mid] < target)
                left = mid + 1;
            else
                right = mid - 1;
        }
        return -1;
    }

    static void Main()
    {
        Console.WriteLine(BinarySearch(new int[] { 1, 2, 3 }, 3));
    }
}
`;

const RUBY_BINARY_SEARCH = `def binary_search(arr, target)
  left = 0
  right = arr.length - 1
  while left <= right
    mid = (left + right) / 2
    if arr[mid] == target
      return mid
    elsif arr[mid] < target
      left = mid + 1
    else
      right = mid - 1
    end
  end
  -1
end

puts binary_search([1, 2, 3], 3)
`;

const PHP_BINARY_SEARCH = `<?php
function binarySearch($arr, $target) {
    $left = 0;
    $right = count($arr) - 1;
    while ($left <= $right) {
        $mid = intdiv($left + $right, 2);
        if ($arr[$mid] == $target) {
            return $mid;
        } elseif ($arr[$mid] < $target) {
            $left = $mid + 1;
        } else {
            $right = $mid - 1;
        }
    }
    return -1;
}

echo binarySearch([1, 2, 3], 3);
`;

const CPP_BINARY_SEARCH = `#include <iostream>
#include <vector>

int binary_search(const std::vector<int>& arr, int target) {
    int left = 0;
    int right = static_cast<int>(arr.size()) - 1;
    while (left <= right) {
        int mid = (left + right) / 2;
        if (arr[mid] == target) {
            return mid;
        } else if (arr[mid] < target) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}

int main() {
    std::vector<int> arr = {1, 2, 3};
    std::cout << binary_search(arr, 3) << std::endl;
    return 0;
}
`;

interface Fixture {
  name: string;
  code: string;
  language: AnalysisLanguage;
  entity: string;
}

const FIXTURES: Fixture[] = [
  { name: "python", code: PYTHON_BINARY_SEARCH, language: "python", entity: "binary_search" },
  { name: "java", code: JAVA_BINARY_SEARCH, language: "java", entity: "Search.binarySearch" },
  { name: "go", code: GO_BINARY_SEARCH, language: "go", entity: "binarySearch" },
  { name: "c", code: C_BINARY_SEARCH, language: "c", entity: "binary_search" },
  { name: "rust", code: RUST_BINARY_SEARCH, language: "rust", entity: "binary_search" },
  { name: "csharp", code: CS_BINARY_SEARCH, language: "csharp", entity: "Search.BinarySearch" },
  { name: "ruby", code: RUBY_BINARY_SEARCH, language: "ruby", entity: "binary_search" },
  { name: "php", code: PHP_BINARY_SEARCH, language: "php", entity: "binarySearch" },
  { name: "cpp", code: CPP_BINARY_SEARCH, language: "cpp", entity: "binary_search" },
];

describe("analyzeCode multi-language extraction", () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      test("detects the language", async () => {
        const a = await analyzeCode(f.code);
        expect(a.language).toBe(f.language);
      });

      test("extracts the binary search entity with a real flow outline", async () => {
        const a = await analyzeCode(f.code);
        const fn = a.entities.find((e) => e.kind === "function" && e.name === f.entity);
        expect(fn).toBeDefined();
        const flow = a.flows?.find((flow) => flow.entity === f.entity);
        expect(flow).toBeDefined();
        expect(flow!.steps.length).toBeGreaterThan(0);
      });

      test("captures the loop and both conditionals as branches", async () => {
        const a = await analyzeCode(f.code);
        const kinds = a.branches.map((b) => b.kind);
        expect(kinds.filter((k) => k === "loop").length).toBeGreaterThanOrEqual(1);
        expect(kinds.filter((k) => k === "if").length).toBeGreaterThanOrEqual(2);
      });

      test("flow outline contains loop, branch and return steps in order", async () => {
        const a = await analyzeCode(f.code);
        const flow = a.flows?.find((item) => item.entity === f.entity);
        expect(flow).toBeDefined();
        const kinds = flow!.steps.map((s) => s.kind);
        expect(kinds).toContain("loop");
        expect(kinds).toContain("branch");
        expect(kinds).toContain("return");
        expect(kinds.indexOf("return")).toBeGreaterThan(kinds.indexOf("loop"));
      });
    });
  }

  test("python IO classification maps print to console", async () => {
    const a = await analyzeCode(PYTHON_BINARY_SEARCH);
    expect(a.ioOperations.map((o) => o.kind)).toContain("console");
  });

  test("python cross-function call references the callee", async () => {
    const a = await analyzeCode(PYTHON_BINARY_SEARCH);
    const moduleFlow = a.flows?.find((f) => f.entity === "(module)");
    expect(moduleFlow).toBeDefined();
    expect(moduleFlow!.steps.some((s) => s.kind === "call" && s.callee === "binary_search")).toBe(
      true
    );
  });

  test("java main flow calls binarySearch and classifies System.out as console", async () => {
    const a = await analyzeCode(JAVA_BINARY_SEARCH);
    const mainFlow = a.flows?.find((f) => f.entity === "Search.main");
    expect(mainFlow).toBeDefined();
    expect(mainFlow!.steps.some((s) => s.kind === "call" && s.callee === "binarySearch")).toBe(true);
    expect(a.ioOperations.map((o) => o.kind)).toContain("console");
  });

  test("explicit language hint wins over detection", async () => {
    const a = await analyzeCode(PYTHON_BINARY_SEARCH, "python");
    expect(a.language).toBe("python");
  });

  test("async python is flagged via async def", async () => {
    const a = await analyzeCode("import asyncio\n\nasync def main():\n    await asyncio.sleep(1)\n");
    expect(a.hasAsync).toBe(true);
    expect(a.ioOperations.map((o) => o.kind)).toContain("timer");
  });
});
