#include <string>
#include <vector>
#include <queue>
#include <cmath>
#include <emscripten/bind.h>

struct CloudRegion {
    std::string name;
    float price;
    float pue;
    float carbon;
    float composite_score;
};

class GridMatcher {
public:
    float calculate_score(float price, float pue, float carbon, float alpha, float beta, float gamma) {
        return (alpha * price) + (beta * pue) + (gamma * carbon);
    }

    std::vector<CloudRegion> rank_regions(std::vector<CloudRegion> regions, float alpha, float beta, float gamma) {
        for (auto& r : regions) {
            r.composite_score = calculate_score(r.price, r.pue, r.carbon, alpha, beta, gamma);
        }

        // min-heap: lowest composite score = best match
        auto cmp = [](const CloudRegion& a, const CloudRegion& b) {
            return a.composite_score > b.composite_score;
        };
        std::priority_queue<CloudRegion, std::vector<CloudRegion>, decltype(cmp)> heap(cmp);

        for (const auto& r : regions) {
            heap.push(r);
        }

        std::vector<CloudRegion> ranked;
        ranked.reserve(regions.size());
        while (!heap.empty()) {
            ranked.push_back(heap.top());
            heap.pop();
        }
        return ranked;
    }

    // Linear regression over historical prices with temperature as exogenous variable
    float predict_missing_price(std::vector<float> historical, float temp) {
        if (historical.empty()) return temp;

        int n = historical.size();
        float sum_x = 0, sum_y = 0, sum_xy = 0, sum_xx = 0;
        for (int i = 0; i < n; ++i) {
            float x = static_cast<float>(i);
            sum_x  += x;
            sum_y  += historical[i];
            sum_xy += x * historical[i];
            sum_xx += x * x;
        }
        float denom = n * sum_xx - sum_x * sum_x;
        if (std::fabs(denom) < 1e-9f) return sum_y / n;

        float slope     = (n * sum_xy - sum_x * sum_y) / denom;
        float intercept = (sum_y - slope * sum_x) / n;
        float trend     = intercept + slope * n; // one step ahead

        // blend trend with temperature signal (equal weight)
        return 0.5f * trend + 0.5f * temp;
    }
};

EMSCRIPTEN_BINDINGS(gridmind_scorer) {
    emscripten::value_object<CloudRegion>("CloudRegion")
        .field("name",            &CloudRegion::name)
        .field("price",           &CloudRegion::price)
        .field("pue",             &CloudRegion::pue)
        .field("carbon",          &CloudRegion::carbon)
        .field("composite_score", &CloudRegion::composite_score);

    emscripten::register_vector<CloudRegion>("VectorCloudRegion");
    emscripten::register_vector<float>("VectorFloat");

    emscripten::class_<GridMatcher>("GridMatcher")
        .constructor<>()
        .function("calculate_score",       &GridMatcher::calculate_score)
        .function("rank_regions",          &GridMatcher::rank_regions)
        .function("predict_missing_price", &GridMatcher::predict_missing_price);
}
